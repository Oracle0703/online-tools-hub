import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_PAYLOAD_VAULT_MAX_BYTES,
  DEFAULT_PAYLOAD_VAULT_MAX_ENTRIES,
  DEFAULT_TEXT_PREVIEW_MAX_BYTES,
  PayloadVault,
  PayloadVaultError,
  textMemoryByteLength,
  type PayloadId,
  type VaultPayload,
} from "../../src/workflows/payload-vault";

function sequenceIds(...ids: string[]): () => string {
  let index = 0;
  return () => ids[index++] ?? `fallback-${String(index).padStart(8, "0")}`;
}

function expectVaultError(
  action: () => unknown,
  code: PayloadVaultError["code"],
): void {
  expect(action).toThrow(PayloadVaultError);
  try {
    action();
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
}

describe("PayloadVault", () => {
  it("uses bounded, memory-only defaults and injectable opaque IDs", () => {
    expect(DEFAULT_PAYLOAD_VAULT_MAX_BYTES).toBe(256 * 1024 * 1024);
    expect(DEFAULT_PAYLOAD_VAULT_MAX_ENTRIES).toBe(64);

    const vault = new PayloadVault({ idFactory: () => "opaque-id-0001" });
    const handle = vault.put({ kind: "text", text: "private" }, "text/plain");

    expect(handle).toEqual({
      id: "opaque-id-0001",
      kind: "text",
      semanticType: "text/plain",
      bytes: 14,
    });
    expect(Object.isFrozen(handle)).toBe(true);
    expect(vault.has(handle.id)).toBe(true);
    expect(vault.snapshot()).toEqual({
      entries: 1,
      bytes: 14,
      disposed: false,
      objectUrls: 0,
    });
  });

  it("owns binary and RGBA bodies through defensive copies in both directions", () => {
    const vault = new PayloadVault({
      idFactory: sequenceIds("opaque-bin-0001", "opaque-rgba-001"),
    });
    const source = new Uint8Array([1, 2, 3, 4]);
    const binary = vault.put(
      { kind: "binary", data: source.buffer, mimeType: "image/png" },
      "binary/png",
    );

    const backing = new Uint8ClampedArray(12);
    backing.set([5, 6, 7, 8], 4);
    const view = new Uint8ClampedArray(backing.buffer, 4, 4);
    const rgba = vault.put(
      { kind: "rgba-image", width: 1, height: 1, data: view },
      "image/rgba",
    );

    source.fill(99);
    view.fill(88);

    const firstBinary = vault.materialize(binary.id);
    expect(firstBinary.kind).toBe("binary");
    if (firstBinary.kind === "binary") {
      expect([...new Uint8Array(firstBinary.data)]).toEqual([1, 2, 3, 4]);
      new Uint8Array(firstBinary.data).fill(77);
    }
    const secondBinary = vault.materialize(binary.id);
    expect(
      secondBinary.kind === "binary" && [...new Uint8Array(secondBinary.data)],
    ).toEqual([1, 2, 3, 4]);
    const binaryInput = vault.materializeInput(binary.id);
    expect(binaryInput.kind).toBe("binary");
    expect("mimeType" in binaryInput).toBe(false);

    const firstRgba = vault.materialize(rgba.id);
    expect(firstRgba.kind).toBe("rgba-image");
    if (firstRgba.kind === "rgba-image") firstRgba.data.fill(66);
    const secondRgba = vault.materialize(rgba.id);
    expect(secondRgba.kind === "rgba-image" && [...secondRgba.data]).toEqual([
      5, 6, 7, 8,
    ]);
  });

  it("charges whichever of UTF-8 and UTF-16 is larger", () => {
    expect(textMemoryByteLength("abcd")).toBe(8);
    expect(textMemoryByteLength("中文")).toBe(6);
    expect(textMemoryByteLength("😀")).toBe(4);
    expect(textMemoryByteLength("\ud800")).toBe(3);

    const utf16Vault = new PayloadVault({
      maxBytes: 8,
      idFactory: () => "opaque-text-001",
    });
    utf16Vault.put({ kind: "text", text: "abcd" }, "text/plain");
    expectVaultError(
      () => utf16Vault.put({ kind: "text", text: "x" }, "text/plain"),
      "memory-budget",
    );

    const utf8Vault = new PayloadVault({
      maxBytes: 6,
      idFactory: () => "opaque-text-002",
    });
    utf8Vault.put({ kind: "text", text: "中文" }, "text/plain");
  });

  it("supports body-free empty inputs and independently budgets text pairs", () => {
    const vault = new PayloadVault({
      idFactory: sequenceIds("opaque-empty-001", "opaque-pair-0001"),
    });
    const empty = vault.put({ kind: "empty" }, "empty");
    const pair = vault.put(
      { kind: "text-pair", left: "abcd", right: "中文" },
      "text/pair",
    );

    expect(empty.bytes).toBe(0);
    expect(vault.materializeInput(empty.id)).toEqual({ kind: "empty" });
    expect(pair.bytes).toBe(14);
    expect(vault.materializeInput(pair.id)).toEqual({
      kind: "text-pair",
      left: "abcd",
      right: "中文",
    });
    expect(vault.preview(pair.id, 6)).toMatchObject({
      left: "a",
      right: "中",
      truncated: true,
    });
  });

  it("returns body-free metadata and produces text previews only on demand", () => {
    const secret = "s".repeat(DEFAULT_TEXT_PREVIEW_MAX_BYTES);
    const vault = new PayloadVault({
      idFactory: sequenceIds("opaque-text-003", "opaque-bin-0002"),
    });
    const text = vault.put(
      { kind: "text", text: `${secret}tail` },
      "text/plain",
    );
    const binary = vault.put(
      {
        kind: "binary",
        data: new Uint8Array([1, 2]).buffer,
        mimeType: "image/png",
      },
      "binary/png",
    );

    const metadata = vault.metadata(text.id);
    expect(metadata).toEqual({
      id: text.id,
      kind: "text",
      semanticType: "text/plain",
      bytes: (secret.length + 4) * 2,
    });
    expect(JSON.stringify(metadata)).not.toContain(secret);
    expect(JSON.stringify(metadata)).not.toMatch(/filename|hash|data/i);

    expect(vault.preview(text.id)).toMatchObject({
      text: "s".repeat(DEFAULT_TEXT_PREVIEW_MAX_BYTES / 2),
      truncated: true,
    });
    const binaryPreview = vault.preview(binary.id);
    expect(binaryPreview).toEqual({
      id: binary.id,
      kind: "binary",
      semanticType: "binary/png",
      bytes: 2,
      mimeType: "image/png",
    });
    expect(JSON.stringify(binaryPreview)).not.toContain("data");
  });

  it("enforces entry and aggregate memory limits without partial inserts", () => {
    const vault = new PayloadVault({
      maxEntries: 1,
      maxBytes: 4,
      idFactory: sequenceIds("opaque-limit-001", "opaque-limit-002"),
    });
    vault.put({ kind: "binary", data: new ArrayBuffer(4) }, "binary/raw");
    expectVaultError(
      () =>
        vault.put({ kind: "binary", data: new ArrayBuffer(1) }, "binary/raw"),
      "entry-limit",
    );
    expect(vault.snapshot()).toMatchObject({ entries: 1, bytes: 4 });

    const memoryVault = new PayloadVault({
      maxBytes: 3,
      idFactory: () => "opaque-limit-003",
    });
    expectVaultError(
      () =>
        memoryVault.put(
          { kind: "binary", data: new ArrayBuffer(4) },
          "binary/raw",
        ),
      "memory-budget",
    );
    expect(memoryVault.snapshot()).toMatchObject({ entries: 0, bytes: 0 });
  });

  it("rejects detached, shared, malformed and accessor-backed payloads", () => {
    const vault = new PayloadVault({ idFactory: () => "opaque-safe-0001" });
    const detached = new ArrayBuffer(2);
    structuredClone(detached, { transfer: [detached] });

    expectVaultError(
      () => vault.put({ kind: "binary", data: detached }, "binary/raw"),
      "invalid-payload",
    );

    if (typeof SharedArrayBuffer !== "undefined") {
      expectVaultError(
        () =>
          vault.put(
            {
              kind: "binary",
              data: new SharedArrayBuffer(4),
            } as unknown as VaultPayload,
            "binary/raw",
          ),
        "invalid-payload",
      );
      expectVaultError(
        () =>
          vault.put(
            {
              kind: "rgba-image",
              width: 1,
              height: 1,
              data: new Uint8ClampedArray(new SharedArrayBuffer(4)),
            },
            "image/rgba",
          ),
        "invalid-payload",
      );
    }

    expectVaultError(
      () =>
        vault.put(
          {
            kind: "rgba-image",
            width: 2,
            height: 1,
            data: new Uint8ClampedArray(4),
          },
          "image/rgba",
        ),
      "invalid-payload",
    );
    expectVaultError(
      () =>
        vault.put(
          {
            kind: "text-pair",
            left: "left",
            right: 2,
          } as unknown as VaultPayload,
          "text/pair",
        ),
      "invalid-payload",
    );
    expectVaultError(
      () =>
        vault.put(
          {
            kind: "binary",
            data: new ArrayBuffer(1),
            mimeType: "image/png; name=private.png",
          },
          "binary/png",
        ),
      "invalid-payload",
    );

    let getterCalls = 0;
    const accessor = { kind: "text" } as Record<string, unknown>;
    Object.defineProperty(accessor, "text", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return "secret";
      },
    });
    expectVaultError(
      () => vault.put(accessor as unknown as VaultPayload, "text/plain"),
      "invalid-payload",
    );
    expect(getterCalls).toBe(0);
  });

  it("validates semantic types and rejects weak or duplicate generated IDs", () => {
    const invalidId = new PayloadVault({ idFactory: () => "short" });
    expectVaultError(
      () => invalidId.put({ kind: "text", text: "a" }, "text/plain"),
      "id-collision",
    );
    expectVaultError(
      () =>
        new PayloadVault({ idFactory: () => "opaque-safe-0002" }).put(
          { kind: "text", text: "a" },
          "Text Secret",
        ),
      "invalid-payload",
    );

    const duplicate = new PayloadVault({ idFactory: () => "opaque-dupe-0001" });
    duplicate.put({ kind: "text", text: "a" }, "text/plain");
    expectVaultError(
      () => duplicate.put({ kind: "text", text: "b" }, "text/plain"),
      "id-collision",
    );
  });

  it("deletes, clears, revokes object URLs and disposes idempotently", () => {
    const revoke = vi.fn();
    const vault = new PayloadVault({
      idFactory: sequenceIds("opaque-clean-001", "opaque-clean-002"),
      revokeObjectUrl: revoke,
    });
    const first = vault.put({ kind: "text", text: "first" }, "text/plain");
    vault.put({ kind: "binary", data: new ArrayBuffer(3) }, "binary/raw");
    vault.registerObjectUrl("blob:first");
    vault.registerObjectUrl("blob:second");
    vault.registerObjectUrl("blob:linked", first.id);
    expect(() =>
      vault.registerObjectUrl("https://example.com/private"),
    ).toThrow(TypeError);

    expect(vault.delete(first.id)).toBe(true);
    expect(vault.delete(first.id)).toBe(false);
    expect(vault.revokeObjectUrl("blob:first")).toBe(true);
    expect(vault.revokeObjectUrl("blob:first")).toBe(false);
    vault.clear();
    vault.clear();
    expect(revoke.mock.calls.flat()).toEqual([
      "blob:linked",
      "blob:first",
      "blob:second",
    ]);
    expect(vault.snapshot()).toEqual({
      entries: 0,
      bytes: 0,
      disposed: false,
      objectUrls: 0,
    });

    vault.dispose();
    vault.dispose();
    expect(vault.delete("opaque-clean-002" as PayloadId)).toBe(false);
    expect(vault.snapshot()).toEqual({
      entries: 0,
      bytes: 0,
      disposed: true,
      objectUrls: 0,
    });
    expectVaultError(() => vault.materialize(first.id), "disposed");
    expectVaultError(
      () => vault.put({ kind: "text", text: "late" }, "text/plain"),
      "disposed",
    );
  });

  it("throws for unknown handles without disclosing the supplied ID", () => {
    const vault = new PayloadVault({ idFactory: () => "opaque-safe-0003" });
    const unknown = "secret-looking-payload-id";
    try {
      vault.materialize(unknown);
      throw new Error("expected materialize to fail");
    } catch (error) {
      expect(error).toMatchObject({ code: "unknown-payload" });
      expect((error as Error).message).not.toContain(unknown);
    }
  });
});

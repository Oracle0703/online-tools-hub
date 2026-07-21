import { describe, expect, it } from "vitest";

import {
  createWorkflowStoreZip,
  MAX_WORKFLOW_ZIP_ARCHIVE_BYTES,
  MAX_WORKFLOW_ZIP_ENTRIES,
  MAX_WORKFLOW_ZIP_ENTRY_BYTES,
  sanitizeWorkflowZipDownloadName,
  WorkflowZipError,
} from "../../src/workflows/zip";

interface ParsedEntry {
  readonly name: string;
  readonly data: Uint8Array;
  readonly method: number;
  readonly dosTime: number;
  readonly dosDate: number;
}

function parseStoreZip(buffer: ArrayBuffer): readonly ParsedEntry[] {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const decoder = new TextDecoder();
  const entries: ParsedEntry[] = [];
  let offset = 0;
  while (
    offset + 4 <= bytes.byteLength &&
    view.getUint32(offset, true) === 0x0403_4b50
  ) {
    const method = view.getUint16(offset + 8, true);
    const dosTime = view.getUint16(offset + 10, true);
    const dosDate = view.getUint16(offset + 12, true);
    const size = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    entries.push({
      name: decoder.decode(bytes.slice(nameStart, nameStart + nameLength)),
      data: bytes.slice(dataStart, dataStart + size),
      method,
      dosTime,
      dosDate,
    });
    offset = dataStart + size;
  }
  return entries;
}

function bytes(value: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(value);
}

async function expectZipCode(
  run: () => Promise<unknown>,
  code: WorkflowZipError["code"],
): Promise<void> {
  await expect(run()).rejects.toMatchObject({
    name: "WorkflowZipError",
    code,
  });
}

describe("workflow STORE ZIP", () => {
  it("creates deterministic STORE entries with fixed private names and epochs", async () => {
    const archive = await createWorkflowStoreZip([
      { data: bytes("first") },
      { data: bytes("second").buffer },
    ]);
    expect(archive).toBeInstanceOf(ArrayBuffer);
    const parsed = parseStoreZip(archive);

    expect(parsed.map((entry) => entry.name)).toEqual([
      "item-001.bin",
      "item-002.bin",
    ]);
    expect(parsed.map((entry) => new TextDecoder().decode(entry.data))).toEqual(
      ["first", "second"],
    );
    expect(parsed.every((entry) => entry.method === 0)).toBe(true);
    expect(parsed.every((entry) => entry.dosTime === 0)).toBe(true);
    expect(parsed.every((entry) => entry.dosDate === 0x21)).toBe(true);
    expect(new TextDecoder().decode(archive)).not.toContain("original-name");
  });

  it("flattens traversal and sanitizes caller-provided download names", async () => {
    expect(
      sanitizeWorkflowZipDownloadName("../../private/report?.json", 0),
    ).toBe("report .json");
    expect(sanitizeWorkflowZipDownloadName("C:\\secret\\CON", 1)).toBe(
      "item-CON",
    );
    expect(sanitizeWorkflowZipDownloadName(" .. ", 2)).toBe("item-003.bin");
    expect(sanitizeWorkflowZipDownloadName(undefined, 9)).toBe("item-010.bin");
    expect(() => sanitizeWorkflowZipDownloadName("x", -1)).toThrow(RangeError);

    const archive = await createWorkflowStoreZip([
      { data: bytes("safe"), downloadName: "../../private/result.json" },
    ]);
    expect(parseStoreZip(archive)[0]?.name).toBe("result.json");
    expect(new TextDecoder().decode(archive)).not.toContain("private/");
  });

  it("enforces entry, item and complete archive limits before unsafe output", async () => {
    await expectZipCode(() => createWorkflowStoreZip([]), "entry-limit");
    await expectZipCode(
      () =>
        createWorkflowStoreZip(
          Array.from({ length: 3 }, () => ({ data: new Uint8Array() })),
          { maxEntries: 2 },
        ),
      "entry-limit",
    );
    await expectZipCode(
      () =>
        createWorkflowStoreZip([{ data: new Uint8Array(2) }], {
          maxEntryBytes: 1,
        }),
      "entry-size-limit",
    );
    await expectZipCode(
      () =>
        createWorkflowStoreZip([{ data: new Uint8Array(1) }], {
          maxArchiveBytes: 40,
        }),
      "archive-size-limit",
    );
    expect(MAX_WORKFLOW_ZIP_ENTRIES).toBe(64);
    expect(MAX_WORKFLOW_ZIP_ENTRY_BYTES).toBe(64 * 1024 * 1024);
    expect(MAX_WORKFLOW_ZIP_ARCHIVE_BYTES).toBe(128 * 1024 * 1024);
  });

  it("rejects duplicate, malformed and accessor-backed entries without reading them", async () => {
    await expectZipCode(
      () =>
        createWorkflowStoreZip([
          { data: bytes("a"), downloadName: "same.txt" },
          { data: bytes("b"), downloadName: "same.txt" },
        ]),
      "duplicate-name",
    );
    await expectZipCode(
      () =>
        createWorkflowStoreZip([
          { data: bytes("a"), downloadName: `bad\ud800.txt` },
        ]),
      "unsafe-name",
    );
    await expectZipCode(
      () =>
        createWorkflowStoreZip([
          { data: bytes("a"), downloadName: 42 as never },
        ]),
      "unsafe-name",
    );
    await expectZipCode(
      () => createWorkflowStoreZip([{ data: "body" as never }]),
      "invalid-entry",
    );
    await expectZipCode(
      () =>
        createWorkflowStoreZip([
          { data: bytes("a"), extra: "secret" } as never,
        ]),
      "invalid-entry",
    );
    await expectZipCode(
      () => createWorkflowStoreZip([new Date() as never]),
      "invalid-entry",
    );

    let getterCalls = 0;
    const entry: Record<string, unknown> = {};
    Object.defineProperty(entry, "data", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return bytes("secret");
      },
    });
    await expectZipCode(
      () => createWorkflowStoreZip([entry as never]),
      "invalid-entry",
    );
    expect(getterCalls).toBe(0);
  });

  it("rejects sparse/custom arrays and unsafe memory views", async () => {
    const sparse = new Array(1) as Array<{ data: Uint8Array }>;
    await expectZipCode(() => createWorkflowStoreZip(sparse), "invalid-entry");
    const custom = [{ data: bytes("ok") }];
    Object.defineProperty(custom, "extra", { enumerable: true, value: true });
    await expectZipCode(() => createWorkflowStoreZip(custom), "invalid-entry");

    if (typeof SharedArrayBuffer !== "undefined") {
      await expectZipCode(
        () =>
          createWorkflowStoreZip([
            { data: new Uint8Array(new SharedArrayBuffer(1)) },
          ]),
        "invalid-entry",
      );
    }
    const detached = new ArrayBuffer(1);
    structuredClone(detached, { transfer: [detached] });
    await expectZipCode(
      () => createWorkflowStoreZip([{ data: detached }]),
      "invalid-entry",
    );
  });

  it("handles null-prototype records and rejects every non-data container", async () => {
    const safe = Object.create(null) as Record<string, unknown>;
    safe.data = bytes("safe");
    safe.downloadName = "safe.txt";
    expect(
      parseStoreZip(await createWorkflowStoreZip([safe as never]))[0]?.name,
    ).toBe("safe.txt");

    await expectZipCode(
      () => createWorkflowStoreZip("not-an-array" as never),
      "invalid-entry",
    );
    await expectZipCode(
      () => createWorkflowStoreZip([null as never]),
      "invalid-entry",
    );
    await expectZipCode(
      () => createWorkflowStoreZip([[bytes("nested")] as never]),
      "invalid-entry",
    );
    await expectZipCode(
      () => createWorkflowStoreZip([{} as never]),
      "invalid-entry",
    );
    await expectZipCode(
      () =>
        createWorkflowStoreZip([
          { data: bytes("x"), [Symbol("private")]: true } as never,
        ]),
      "invalid-entry",
    );
    const hidden = {};
    Object.defineProperty(hidden, "data", {
      enumerable: false,
      value: bytes("hidden"),
    });
    await expectZipCode(
      () => createWorkflowStoreZip([hidden as never]),
      "invalid-entry",
    );
  });

  it("bounds normalized UTF-8 names without splitting surrogate pairs", () => {
    expect(() => sanitizeWorkflowZipDownloadName("", 0)).toThrow(
      expect.objectContaining({ code: "unsafe-name" }),
    );
    expect(() => sanitizeWorkflowZipDownloadName("\udc00", 0)).toThrow(
      expect.objectContaining({ code: "unsafe-name" }),
    );
    expect(sanitizeWorkflowZipDownloadName("😀.txt", 0)).toBe("😀.txt");
    const limited = sanitizeWorkflowZipDownloadName("界".repeat(200), 0);
    expect(new TextEncoder().encode(limited).byteLength).toBeLessThanOrEqual(
      255,
    );
    expect(limited).not.toContain("�");
  });

  it("observes cancellation before work and between bounded copy chunks", async () => {
    const early = new AbortController();
    early.abort();
    await expectZipCode(
      () =>
        createWorkflowStoreZip([{ data: bytes("secret") }], {
          signal: early.signal,
        }),
      "cancelled",
    );

    const during = new AbortController();
    const creating = createWorkflowStoreZip(
      [{ data: new Uint8Array(2 * 1024 * 1024) }],
      { signal: during.signal },
    );
    globalThis.setTimeout(() => during.abort(), 0);
    await expectZipCode(() => creating, "cancelled");
  });

  it("validates privacy-reviewed option ceilings", async () => {
    for (const options of [
      { maxEntries: 0 },
      { maxEntries: MAX_WORKFLOW_ZIP_ENTRIES + 1 },
      { maxEntryBytes: MAX_WORKFLOW_ZIP_ENTRY_BYTES + 1 },
      { maxArchiveBytes: Number.NaN },
    ]) {
      await expect(
        createWorkflowStoreZip([{ data: bytes("x") }], options),
      ).rejects.toBeInstanceOf(RangeError);
    }
    expect(() => sanitizeWorkflowZipDownloadName("x".repeat(4097), 0)).toThrow(
      expect.objectContaining({ code: "unsafe-name" }),
    );
  });
});

describe("WorkflowZipError", () => {
  it("keeps public errors stable and payload-free", () => {
    const error = new WorkflowZipError("archive-size-limit");
    expect(error).toEqual(
      expect.objectContaining({
        name: "WorkflowZipError",
        code: "archive-size-limit",
        message: "The ZIP archive exceeds the size limit.",
      }),
    );
    expect(JSON.stringify(error)).not.toContain("private");
  });
});

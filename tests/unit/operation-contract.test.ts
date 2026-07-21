import { describe, expect, it } from "vitest";

import type {
  OperationManifest,
  OperationPayload,
} from "../../src/operations/contract";
import {
  BASE64_OPERATION_MANIFEST,
  IMAGE_OPERATION_MANIFEST,
  JSON_OPERATION_MANIFEST,
  UUID_OPERATION_MANIFEST,
  YAML_OPERATION_MANIFEST,
} from "../../src/operations/catalog";
import {
  OperationError,
  deserializeOperationError,
  operationErrorCodes,
  serializeOperationError,
} from "../../src/operations/errors";
import {
  MAX_OPERATION_OPTIONS_BYTES,
  assertOperationManifest,
  assertOperationRequest,
  assertWorkingMemoryWithinBudget,
  payloadByteLength,
  normalizeOperationOptions,
  resolveOperationSignature,
  validateJsonValue,
  validateAndNormalizeOperationOptions,
  validateOperationManifest,
  validateOperationOptions,
  validateOperationOutput,
  validateOperationRequest,
  validateWorkingMemory,
} from "../../src/operations/validation";

const manifest: OperationManifest = {
  version: 1,
  id: "json.transform",
  toolSlug: "json-formatter",
  inputKinds: ["text", "binary"],
  outputKinds: ["text"],
  maxInputBytes: 16,
  maxOutputBytes: 32,
  workingMemoryBytes: 64,
  options: {
    additionalProperties: "forbidden",
    properties: {},
  },
  signatures: [
    {
      when: {},
      input: [
        { kind: "text", contentType: "text/plain" },
        { kind: "binary", contentType: "application/octet-stream" },
      ],
      output: { kind: "text", contentType: "text/plain" },
      determinism: "deterministic",
    },
  ],
  determinism: "deterministic",
  execution: {
    strategy: "adaptive",
    workerThresholdBytes: 8,
    timeoutMs: 2_000,
  },
  capabilities: {
    network: "forbidden",
    persistence: "forbidden",
    environment: ["text-codec"],
  },
};

function cloneManifest(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(manifest)) as Record<string, unknown>;
}

function expectErrorCode(
  result: { ok: true } | { ok: false; error: OperationError },
  code: OperationError["code"],
): void {
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.code).toBe(code);
}

describe("Operation payload contract", () => {
  it("counts UTF-8, pair, binary and RGBA payload bytes without a DOM", () => {
    const cases: Array<[OperationPayload, number]> = [
      [{ kind: "empty" }, 0],
      [{ kind: "text", text: "A中😀" }, 8],
      [{ kind: "text", text: "\ud800" }, 3],
      [{ kind: "text-pair", left: "ab", right: "中文" }, 8],
      [{ kind: "binary", data: new ArrayBuffer(5) }, 5],
      [
        {
          kind: "rgba-image",
          width: 2,
          height: 2,
          data: new Uint8ClampedArray(16),
        },
        16,
      ],
    ];

    for (const [payload, expected] of cases) {
      expect(payloadByteLength(payload)).toBe(expected);
    }
  });
});

describe("JSON-only Operation options", () => {
  it("accepts nested JSON with plain and null-prototype records", () => {
    const nested = Object.assign(
      Object.create(null) as Record<string, unknown>,
      {
        enabled: true,
        values: [1, "two", null, { ok: false }],
      },
    );

    expect(validateJsonValue(nested)).toEqual({ ok: true, value: nested });
    expect(validateOperationOptions(nested, manifest.id)).toEqual({
      ok: true,
      value: nested,
    });
  });

  it.each([
    ["root array", []],
    ["non-finite number", { value: Number.NaN }],
    ["undefined", { value: undefined }],
    ["bigint", { value: 1n }],
    ["function", { value: () => undefined }],
    ["class instance", { value: new Date(0) }],
    ["sparse array", { value: new Array(2) }],
  ])("rejects %s", (_name, value) => {
    expectErrorCode(
      validateOperationOptions(value, manifest.id),
      "invalid-options",
    );
  });

  it("rejects circular references without rejecting shared JSON values", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expectErrorCode(validateOperationOptions(circular), "invalid-options");

    const shared = { safe: true };
    expect(validateOperationOptions({ first: shared, second: shared }).ok).toBe(
      true,
    );
  });

  it("blocks prototype-pollution keys, symbols and accessors", () => {
    const pollution = JSON.parse(
      '{"nested":{"__proto__":{"polluted":true}}}',
    ) as unknown;
    expectErrorCode(validateOperationOptions(pollution), "invalid-options");

    expectErrorCode(
      validateOperationOptions({ [Symbol("secret")]: true }),
      "invalid-options",
    );

    const accessor: Record<string, unknown> = {};
    Object.defineProperty(accessor, "value", {
      enumerable: true,
      get: () => "must not run",
    });
    expectErrorCode(validateOperationOptions(accessor), "invalid-options");

    let arrayGetterCalls = 0;
    const accessorArray = ["safe"];
    Object.defineProperty(accessorArray, "0", {
      enumerable: true,
      get: () => {
        arrayGetterCalls += 1;
        return "must not run";
      },
    });
    expectErrorCode(
      validateOperationOptions({ value: accessorArray }),
      "invalid-options",
    );
    expect(arrayGetterCalls).toBe(0);
  });

  it("enforces a 64 KiB serialized options budget, including escapes", () => {
    expect(MAX_OPERATION_OPTIONS_BYTES).toBe(64 * 1024);
    expect(
      validateOperationOptions({ value: "a".repeat(64 * 1024) }),
    ).toMatchObject({
      ok: false,
      error: { code: "invalid-options" },
    });
    expect(
      validateOperationOptions({ value: "\u0000".repeat(11_000) }),
    ).toMatchObject({
      ok: false,
      error: { code: "invalid-options" },
    });
    expect(
      validateOperationOptions({ value: "\ud800".repeat(11_000) }),
    ).toMatchObject({
      ok: false,
      error: { code: "invalid-options" },
    });
  });
});

describe("declarative Operation options and signatures", () => {
  it("materializes explicit defaults into a frozen canonical record", () => {
    const normalized = normalizeOperationOptions(JSON_OPERATION_MANIFEST, {});
    expect(normalized).toEqual({ mode: "format", indent: 2 });
    expect(Object.isFrozen(normalized)).toBe(true);

    expect(
      validateAndNormalizeOperationOptions(JSON_OPERATION_MANIFEST, {
        mode: "minify",
      }),
    ).toEqual({
      ok: true,
      value: { mode: "minify", indent: 2 },
    });
  });

  it.each([
    [JSON_OPERATION_MANIFEST, { rogue: true }],
    [JSON_OPERATION_MANIFEST, { mode: "repair" }],
    [IMAGE_OPERATION_MANIFEST, { paletteColors: 1 }],
    [IMAGE_OPERATION_MANIFEST, { paletteColors: 2.5 }],
  ])(
    "rejects unknown, enum and range violations before execution",
    (entry, value) => {
      expect(() => normalizeOperationOptions(entry, value)).toThrow(
        expect.objectContaining({ code: "invalid-options" }),
      );
    },
  );

  it("resolves option-selected content types and determinism", () => {
    const base64 = normalizeOperationOptions(BASE64_OPERATION_MANIFEST, {
      mode: "decode",
      variant: "url",
      decodedContentType: "application/json",
    });
    expect(
      resolveOperationSignature(BASE64_OPERATION_MANIFEST, base64),
    ).toEqual(
      expect.objectContaining({
        input: [{ kind: "text", contentType: "application/base64url" }],
        output: { kind: "text", contentType: "application/json" },
        determinism: "deterministic",
      }),
    );

    const yaml = normalizeOperationOptions(YAML_OPERATION_MANIFEST, {
      direction: "json-to-yaml",
    });
    expect(
      resolveOperationSignature(YAML_OPERATION_MANIFEST, yaml).output,
    ).toEqual({ kind: "text", contentType: "application/yaml" });

    const uuid = normalizeOperationOptions(UUID_OPERATION_MANIFEST, {});
    expect(
      resolveOperationSignature(UUID_OPERATION_MANIFEST, uuid).determinism,
    ).toBe("random");
  });
});

describe("Operation manifest invariants", () => {
  it("accepts a strictly serializable manifest and assertion API", () => {
    const result = validateOperationManifest(manifest);
    expect(result).toEqual({ ok: true, value: manifest });
    expect(() => assertOperationManifest(manifest)).not.toThrow();
    expect(JSON.parse(JSON.stringify(manifest))).toEqual(manifest);
  });

  it.each([
    ["unsupported version", { version: 2 }],
    ["invalid id", { id: "JSON Transform" }],
    ["invalid tool slug", { toolSlug: "../json" }],
    ["empty input kinds", { inputKinds: [] }],
    ["duplicate input kinds", { inputKinds: ["text", "text"] }],
    ["unknown output kind", { outputKinds: ["json"] }],
    ["negative input limit", { maxInputBytes: -1 }],
    ["zero output limit", { maxOutputBytes: 0 }],
    ["fractional memory", { workingMemoryBytes: 64.5 }],
    ["insufficient memory", { workingMemoryBytes: 20 }],
  ])("rejects %s", (_name, override) => {
    const value = { ...cloneManifest(), ...override };
    expectErrorCode(validateOperationManifest(value), "execution-failed");
    expect(() => assertOperationManifest(value)).toThrow(OperationError);
  });

  it.each([
    ["main", 1],
    ["worker", null],
    ["adaptive", null],
    ["adaptive", 17],
    ["unknown", 0],
  ])("rejects invalid %s execution threshold %s", (strategy, threshold) => {
    const value = cloneManifest();
    value.execution = {
      strategy,
      workerThresholdBytes: threshold,
      timeoutMs: 100,
    };
    expectErrorCode(validateOperationManifest(value), "execution-failed");
  });

  it("requires explicit forbidden network and persistence capabilities", () => {
    for (const capabilities of [
      { network: "allowed", persistence: "forbidden", environment: [] },
      { network: "forbidden", persistence: "allowed", environment: [] },
      {
        network: "forbidden",
        persistence: "forbidden",
        environment: ["web-crypto", "web-crypto"],
      },
    ]) {
      const value = cloneManifest();
      value.capabilities = capabilities;
      expectErrorCode(validateOperationManifest(value), "execution-failed");
    }
  });

  it("rejects extra fields and non-JSON manifest values", () => {
    expectErrorCode(
      validateOperationManifest({ ...manifest, execute: () => undefined }),
      "execution-failed",
    );
    expectErrorCode(
      validateOperationManifest({ ...manifest, secret: "extra" }),
      "execution-failed",
    );
  });

  it("rejects malformed option declarations and semantic signatures", () => {
    const invalidDefault = cloneManifest();
    invalidDefault.options = {
      additionalProperties: "forbidden",
      properties: {
        mode: { type: "enum", values: ["format"], default: "repair" },
      },
    };
    expectErrorCode(
      validateOperationManifest(invalidDefault),
      "execution-failed",
    );

    const unknownCondition = cloneManifest();
    unknownCondition.signatures = [
      {
        when: { rogue: true },
        input: [{ kind: "text", contentType: "text/plain" }],
        output: { kind: "text", contentType: "text/plain" },
        determinism: "deterministic",
      },
    ];
    expectErrorCode(
      validateOperationManifest(unknownCondition),
      "execution-failed",
    );

    const invalidContentType = cloneManifest();
    invalidContentType.signatures = [
      {
        when: {},
        input: [{ kind: "text", contentType: "JSON" }],
        output: { kind: "text", contentType: "text/plain" },
        determinism: "deterministic",
      },
    ];
    expectErrorCode(
      validateOperationManifest(invalidContentType),
      "execution-failed",
    );
  });
});

describe("pre-execution validation", () => {
  it("normalizes a valid request to explicit empty options", () => {
    const request = {
      operationId: manifest.id,
      input: { kind: "text", text: "你好" },
    };
    expect(validateOperationRequest(manifest, request)).toEqual({
      ok: true,
      value: { ...request, options: {} },
    });
    expect(() => assertOperationRequest(manifest, request)).not.toThrow();
  });

  it("does not treat an explicit null options value as an omitted record", () => {
    expectErrorCode(
      validateOperationRequest(manifest, {
        operationId: manifest.id,
        input: { kind: "text", text: "safe" },
        options: null,
      }),
      "invalid-options",
    );
  });

  it("distinguishes unknown operations, type mismatches and input limits", () => {
    expectErrorCode(
      validateOperationRequest(undefined, {
        operationId: "missing.operation",
        input: { kind: "text", text: "ok" },
      }),
      "unknown-operation",
    );
    expectErrorCode(
      validateOperationRequest(manifest, {
        operationId: "other.operation",
        input: { kind: "text", text: "ok" },
      }),
      "unknown-operation",
    );
    expectErrorCode(
      validateOperationRequest(manifest, {
        operationId: manifest.id,
        input: { kind: "text-pair", left: "a", right: "b" },
      }),
      "type-mismatch",
    );
    expectErrorCode(
      validateOperationRequest(manifest, {
        operationId: manifest.id,
        input: { kind: "text", text: "中".repeat(6) },
      }),
      "input-too-large",
    );
  });

  it("does not echo unknown operation IDs or payload kinds into errors", () => {
    const secret = "OPERATION_UNKNOWN_CANARY_51f0";
    const unknownOperation = validateOperationRequest(undefined, {
      operationId: secret,
      input: { kind: "text", text: "safe" },
    });
    const unknownKind = validateOperationRequest(manifest, {
      operationId: manifest.id,
      input: { kind: secret, text: "safe" },
    });

    expect(unknownOperation.ok).toBe(false);
    expect(unknownKind.ok).toBe(false);
    for (const result of [unknownOperation, unknownKind]) {
      if (!result.ok) {
        expect(JSON.stringify(result.error.toJSON())).not.toContain(secret);
      }
    }
  });

  it("validates binary and exact RGBA image shapes", () => {
    expect(
      validateOperationRequest(manifest, {
        operationId: manifest.id,
        input: { kind: "binary", data: new ArrayBuffer(16) },
      }).ok,
    ).toBe(true);

    const rgbaManifest: OperationManifest = {
      ...manifest,
      inputKinds: ["rgba-image"],
      signatures: [
        {
          when: {},
          input: [{ kind: "rgba-image", contentType: "image/x-rgba" }],
          output: { kind: "text", contentType: "text/plain" },
          determinism: "deterministic",
        },
      ],
    };
    expect(
      validateOperationRequest(rgbaManifest, {
        operationId: rgbaManifest.id,
        input: {
          kind: "rgba-image",
          width: 2,
          height: 2,
          data: new Uint8ClampedArray(15),
        },
      }),
    ).toMatchObject({ ok: false, error: { code: "type-mismatch" } });

    const oversizedBacking = new ArrayBuffer(32);
    expect(
      validateOperationRequest(rgbaManifest, {
        operationId: rgbaManifest.id,
        input: {
          kind: "rgba-image",
          width: 2,
          height: 2,
          data: new Uint8ClampedArray(oversizedBacking, 8, 16),
        },
      }),
    ).toMatchObject({ ok: false, error: { code: "type-mismatch" } });

    if (typeof SharedArrayBuffer !== "undefined") {
      expect(
        validateOperationRequest(rgbaManifest, {
          operationId: rgbaManifest.id,
          input: {
            kind: "rgba-image",
            width: 1,
            height: 1,
            data: new Uint8ClampedArray(new SharedArrayBuffer(4)),
          },
        }),
      ).toMatchObject({ ok: false, error: { code: "type-mismatch" } });
    }
  });

  it("rejects request, payload and output accessors without invoking them", () => {
    let reads = 0;
    const input = { kind: "text" } as Record<string, unknown>;
    Object.defineProperty(input, "text", {
      enumerable: true,
      get() {
        reads += 1;
        return "hidden";
      },
    });
    expectErrorCode(
      validateOperationRequest(manifest, {
        operationId: manifest.id,
        input,
      }),
      "type-mismatch",
    );

    const request = { operationId: manifest.id } as Record<string, unknown>;
    Object.defineProperty(request, "input", {
      enumerable: true,
      get() {
        reads += 1;
        return { kind: "text", text: "hidden" };
      },
    });
    expectErrorCode(
      validateOperationRequest(manifest, request),
      "type-mismatch",
    );

    const output = { kind: "text" } as Record<string, unknown>;
    Object.defineProperty(output, "text", {
      enumerable: true,
      get() {
        reads += 1;
        return "hidden";
      },
    });
    expectErrorCode(validateOperationOutput(manifest, output), "type-mismatch");
    expect(reads).toBe(0);
  });

  it("validates output type and byte budget", () => {
    expect(
      validateOperationOutput(manifest, { kind: "text", text: "result" }),
    ).toMatchObject({ ok: true });
    expectErrorCode(
      validateOperationOutput(manifest, {
        kind: "binary",
        data: new ArrayBuffer(1),
      }),
      "type-mismatch",
    );
    expectErrorCode(
      validateOperationOutput(manifest, {
        kind: "text",
        text: "x".repeat(33),
      }),
      "output-too-large",
    );
  });

  it("enforces working-memory reservations", () => {
    expect(validateWorkingMemory(manifest, 64)).toEqual({
      ok: true,
      value: 64,
    });
    expectErrorCode(validateWorkingMemory(manifest, 65), "memory-budget");
    expectErrorCode(
      validateWorkingMemory(manifest, Number.NaN),
      "memory-budget",
    );
    expect(() => assertWorkingMemoryWithinBudget(manifest, 65)).toThrow(
      OperationError,
    );
  });
});

describe("Operation errors", () => {
  it("exposes exactly the stable v1 error vocabulary", () => {
    expect(operationErrorCodes).toEqual([
      "unknown-operation",
      "type-mismatch",
      "input-too-large",
      "output-too-large",
      "memory-budget",
      "invalid-options",
      "timeout",
      "cancelled",
      "worker-crashed",
      "execution-failed",
      "unsupported-environment",
    ]);
  });

  it("round-trips a serializable error without leaking its cause", () => {
    const error = new OperationError("execution-failed", "Transform failed.", {
      operationId: manifest.id,
      details: { phase: "parse" },
      cause: new Error("sensitive source"),
    });
    const serialized = serializeOperationError(error);

    expect(serialized).toEqual({
      name: "OperationError",
      code: "execution-failed",
      message: "Transform failed.",
      operationId: manifest.id,
      details: { phase: "parse" },
    });
    expect(JSON.stringify(serialized)).not.toContain("sensitive source");
    expect(deserializeOperationError(serialized)).toMatchObject({
      name: "OperationError",
      code: "execution-failed",
      operationId: manifest.id,
    });
  });
});

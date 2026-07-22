import { describe, expect, it, vi } from "vitest";

import {
  MAX_WORKFLOW_BATCH_FILES,
  MAX_WORKFLOW_BATCH_SOURCE_BYTES,
  WorkflowFileInputError,
  getWorkflowFilePolicy,
  getWorkflowPlanFilePolicy,
  readWorkflowSourceFile,
  validateWorkflowFileQueue,
  type WorkflowSourceFile,
} from "../../src/workflows/file-input";
import {
  WORKFLOW_RECIPE_FORMAT,
  WORKFLOW_RECIPE_VERSION,
  type WorkflowRecipeV1,
} from "../../src/workflows/contract";
import { compileWorkflowCandidate } from "../../src/workflows/planner";

const PNG_SIGNATURE = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

function ascii(value: string): Uint8Array {
  return Uint8Array.from(value, (character) => character.charCodeAt(0));
}

function uint32(value: number): Uint8Array {
  return Uint8Array.from([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);
}

function concat(...values: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(
    values.reduce((total, value) => total + value.byteLength, 0),
  );
  let offset = 0;
  for (const value of values) {
    result.set(value, offset);
    offset += value.byteLength;
  }
  return result;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  return concat(uint32(data.byteLength), ascii(type), data, new Uint8Array(4));
}

function png(width = 1, height = 1, animated = false): Uint8Array {
  const header = pngChunk(
    "IHDR",
    concat(uint32(width), uint32(height), Uint8Array.from([8, 6, 0, 0, 0])),
  );
  return concat(
    PNG_SIGNATURE,
    header,
    ...(animated ? [pngChunk("acTL", concat(uint32(2), uint32(0)))] : []),
  );
}

function sourceFile(
  bytes: Uint8Array,
  reportedSize = bytes.byteLength,
): WorkflowSourceFile {
  return {
    size: reportedSize,
    async arrayBuffer() {
      return bytes.slice().buffer;
    },
  };
}

function expectErrorCode(error: unknown, code: string): boolean {
  expect(error).toBeInstanceOf(WorkflowFileInputError);
  expect(error).toMatchObject({ code });
  return true;
}

function planFor(
  operationId: string,
  options: WorkflowRecipeV1["steps"][number]["options"] = {},
) {
  return compileWorkflowCandidate({
    format: WORKFLOW_RECIPE_FORMAT,
    version: WORKFLOW_RECIPE_VERSION,
    steps: [{ operationId, options }],
  });
}

describe("workflow file policy and queue bounds", () => {
  it("derives safe, template-specific policies", () => {
    expect(getWorkflowFilePolicy("base64-json-inspect")).toMatchObject({
      inputKind: "text",
      semanticType: "application/base64",
      maxSourceBytes: 2 * 1024 * 1024,
    });
    expect(getWorkflowFilePolicy("yaml-config-to-base64url")?.accept).toContain(
      ".yaml",
    );
    expect(getWorkflowFilePolicy("csv-api-fixture-sha256")?.accept).toContain(
      ".csv",
    );
    expect(getWorkflowFilePolicy("png-palette-sha256")).toMatchObject({
      inputKind: "rgba-image",
      semanticType: "image/x-rgba",
      maxSourceBytes: 20 * 1024 * 1024,
    });
    expect(getWorkflowFilePolicy("missing")).toBeUndefined();
  });

  it("derives custom text policy only from the compiled plan's first step", () => {
    const base64Decode = planFor("base64.codec", {
      mode: "decode",
      variant: "standard",
      decodedContentType: "application/json",
    });

    expect(getWorkflowPlanFilePolicy(base64Decode)).toEqual({
      inputKind: "text",
      semanticType: "application/base64",
      maxSourceBytes: 2 * 1024 * 1024,
      accept: ".txt,text/plain",
    });
    expect(getWorkflowPlanFilePolicy(base64Decode)).not.toHaveProperty(
      "templateId",
    );
  });

  it("fails closed for custom empty, text-pair and RGBA first steps", () => {
    expect(getWorkflowPlanFilePolicy(planFor("uuid.generate"))).toBeUndefined();
    expect(getWorkflowPlanFilePolicy(planFor("text.diff"))).toBeUndefined();
    expect(
      getWorkflowPlanFilePolicy(planFor("image.rgba-to-png")),
    ).toBeUndefined();

    expect(
      validateWorkflowFileQueue([{ size: 1 }], planFor("text.diff")),
    ).toMatchObject({ ok: false, error: { code: "unknown-template" } });
  });

  it("accepts a bounded queue without retaining filenames", () => {
    const result = validateWorkflowFileQueue(
      [{ size: 3 }, { size: 5 }],
      "base64-json-inspect",
    );

    expect(result).toMatchObject({
      ok: true,
      value: { count: 2, totalBytes: 8 },
    });
    expect(JSON.stringify(result)).not.toContain("name");
  });

  it.each([
    [[], "base64-json-inspect", "empty-selection"],
    [
      Array.from({ length: MAX_WORKFLOW_BATCH_FILES + 1 }, () => ({ size: 1 })),
      "base64-json-inspect",
      "too-many-files",
    ],
    [[{ size: -1 }], "base64-json-inspect", "invalid-file-size"],
    [[{ size: Number.NaN }], "base64-json-inspect", "invalid-file-size"],
    [[{ size: 0 }], "base64-json-inspect", "empty-file"],
    [[{ size: 2 * 1024 * 1024 + 1 }], "base64-json-inspect", "file-too-large"],
    [[{ size: 1 }], "missing", "unknown-template"],
  ] as const)("rejects an unsafe queue with %s", (files, templateId, code) => {
    const result = validateWorkflowFileQueue(files, templateId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(code);
  });

  it("rejects a queue whose aggregate compressed size exceeds its cap", () => {
    const perFile = Math.floor(MAX_WORKFLOW_BATCH_SOURCE_BYTES / 4) + 1;
    const result = validateWorkflowFileQueue(
      Array.from({ length: 4 }, () => ({ size: perFile })),
      "png-palette-sha256",
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: "total-too-large" },
    });
  });
});

describe("readWorkflowSourceFile", () => {
  it("strictly reads custom-plan text with plan-derived semantics", async () => {
    const plan = planFor("yaml.convert", {
      direction: "yaml-to-json",
      jsonIndent: 2,
    });
    const body = "release: v1.1\n";
    const result = await readWorkflowSourceFile(
      sourceFile(new TextEncoder().encode(body)),
      plan,
    );

    expect(result).toEqual({
      input: { kind: "text", text: body },
      semanticType: "application/yaml",
      sourceBytes: body.length,
    });
  });

  it("strictly decodes UTF-8 and returns a body-free descriptor", async () => {
    const body = "eyJvayI6dHJ1ZX0=";
    const result = await readWorkflowSourceFile(
      sourceFile(new TextEncoder().encode(body)),
      "base64-json-inspect",
    );

    expect(result).toEqual({
      input: { kind: "text", text: body },
      semanticType: "application/base64",
      sourceBytes: body.length,
    });
  });

  it("rejects invalid UTF-8, size races and read failures canonically", async () => {
    await expect(
      readWorkflowSourceFile(
        sourceFile(Uint8Array.from([0xc3, 0x28])),
        "base64-json-inspect",
      ),
    ).rejects.toSatisfy((error: unknown) =>
      expectErrorCode(error, "invalid-text"),
    );

    await expect(
      readWorkflowSourceFile(
        sourceFile(Uint8Array.from([1, 2]), 3),
        "base64-json-inspect",
      ),
    ).rejects.toSatisfy((error: unknown) =>
      expectErrorCode(error, "invalid-file-size"),
    );

    await expect(
      readWorkflowSourceFile(
        {
          size: 1,
          arrayBuffer: () => Promise.reject(new Error("private body")),
        },
        "base64-json-inspect",
      ),
    ).rejects.toSatisfy((error: unknown) =>
      expectErrorCode(error, "decode-failed"),
    );
  });

  it("cancels before reading and after an in-flight read", async () => {
    const before = new AbortController();
    before.abort();
    const read = vi.fn(() => Promise.resolve(new ArrayBuffer(1)));
    await expect(
      readWorkflowSourceFile(
        { size: 1, arrayBuffer: read },
        "base64-json-inspect",
        { signal: before.signal },
      ),
    ).rejects.toSatisfy((error: unknown) =>
      expectErrorCode(error, "cancelled"),
    );
    expect(read).not.toHaveBeenCalled();

    const during = new AbortController();
    await expect(
      readWorkflowSourceFile(
        {
          size: 1,
          async arrayBuffer() {
            during.abort();
            return new ArrayBuffer(1);
          },
        },
        "base64-json-inspect",
        { signal: during.signal },
      ),
    ).rejects.toSatisfy((error: unknown) =>
      expectErrorCode(error, "cancelled"),
    );
  });

  it("inspects a static image before invoking the injected pixel decoder", async () => {
    const decode = vi.fn(async () => ({
      kind: "rgba-image" as const,
      width: 1,
      height: 1,
      data: new Uint8ClampedArray([255, 0, 0, 255]),
    }));
    const bytes = png();
    const result = await readWorkflowSourceFile(
      sourceFile(bytes),
      "png-palette-sha256",
      { imageDecoder: decode, memoryEnvironment: { coarsePointer: true } },
    );

    expect(result).toMatchObject({
      semanticType: "image/x-rgba",
      sourceBytes: bytes.byteLength,
      input: { kind: "rgba-image", width: 1, height: 1 },
    });
    expect(decode).toHaveBeenCalledWith(
      expect.objectContaining({
        format: "png",
        declaredWidth: 1,
        declaredHeight: 1,
      }),
    );
  });

  it.each([
    [sourceFile(Uint8Array.from([1, 2, 3])), "unsupported-image"],
    [sourceFile(png(1, 1, true)), "animated-image"],
    [sourceFile(PNG_SIGNATURE), "invalid-image"],
    [sourceFile(png(4001, 3000)), "device-memory-limit"],
  ] as const)("rejects unsafe image input as %s", async (file, code) => {
    const decode = vi.fn();
    await expect(
      readWorkflowSourceFile(file, "png-palette-sha256", {
        imageDecoder: decode,
        memoryEnvironment: { coarsePointer: true },
      }),
    ).rejects.toSatisfy((error: unknown) => expectErrorCode(error, code));
    expect(decode).not.toHaveBeenCalled();
  });

  it("requires a browser decoder and canonicalizes decoder failures", async () => {
    await expect(
      readWorkflowSourceFile(sourceFile(png()), "png-palette-sha256"),
    ).rejects.toSatisfy((error: unknown) =>
      expectErrorCode(error, "decode-failed"),
    );

    await expect(
      readWorkflowSourceFile(sourceFile(png()), "png-palette-sha256", {
        imageDecoder: async () => {
          throw new Error("private decoder detail");
        },
      }),
    ).rejects.toSatisfy((error: unknown) =>
      expectErrorCode(error, "decode-failed"),
    );
  });

  it("rejects malformed decoded pixels without exposing source data", async () => {
    await expect(
      readWorkflowSourceFile(sourceFile(png()), "png-palette-sha256", {
        imageDecoder: async () => ({
          kind: "rgba-image",
          width: 2,
          height: 1,
          data: new Uint8ClampedArray(4),
        }),
      }),
    ).rejects.toSatisfy((error: unknown) =>
      expectErrorCode(error, "decode-failed"),
    );

    const error = new WorkflowFileInputError("invalid-text");
    expect(JSON.stringify(error)).toBe(
      '{"name":"WorkflowFileInputError","code":"invalid-text","message":"文件不是有效的 UTF-8 文本。"}',
    );
    expect(JSON.stringify(error)).not.toContain("secret-file-name");
  });
});

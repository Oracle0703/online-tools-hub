import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getOperationManifest,
  operationIds,
  operationManifests,
} from "../../src/operations/catalog";
import type {
  JsonObject,
  OperationDefinition,
  OperationExecutionContext,
  OperationInput,
  OperationManifest,
} from "../../src/operations/contract";
import { OperationError } from "../../src/operations/errors";
import {
  loadOperationDefinition,
  operationLoaderIds,
} from "../../src/operations/runtime-registry";
import {
  normalizeOperationOptions,
  resolveOperationSignature,
  validateOperationManifest,
} from "../../src/operations/validation";
import { encodeBase64 } from "../../src/tools/base64-codec";
import { enabledTools } from "../../src/lib/tool-catalog";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

afterEach(() => {
  vi.unstubAllGlobals();
});

function createContext(
  location: "main" | "worker" = "main",
): OperationExecutionContext {
  const controller = new AbortController();
  return {
    signal: controller.signal,
    location,
    checkCancelled: vi.fn(),
    assertWorkingMemory: vi.fn(),
  };
}

async function execute(
  operationId: string,
  input: OperationInput,
  options: JsonObject = {},
  location: "main" | "worker" = "main",
) {
  const definition = await loadOperationDefinition(operationId);
  return definition.execute(input, options, createContext(location));
}

function minimalInput(definition: OperationDefinition): OperationInput {
  switch (definition.manifest.inputKinds[0]) {
    case "empty":
      return { kind: "empty" };
    case "text":
      return { kind: "text", text: "" };
    case "text-pair":
      return { kind: "text-pair", left: "", right: "" };
    case "binary":
      return { kind: "binary", data: new ArrayBuffer(0) };
    case "rgba-image":
      return {
        kind: "rgba-image",
        width: 1,
        height: 1,
        data: new Uint8ClampedArray(4),
      };
    default:
      throw new Error("Manifest has no supported input kind.");
  }
}

function expectDeepFrozen(value: unknown, seen = new WeakSet<object>()): void {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) expectDeepFrozen(child, seen);
}

function invalidValueForSchema(
  schema: OperationManifest["options"]["properties"][string],
): JsonObject[string] {
  switch (schema.type) {
    case "enum":
      return "__invalid_option_value__";
    case "boolean":
      return "false";
    case "integer":
    case "number":
      return schema.maximum + 1;
    case "string":
      return "";
  }
}

describe("Operation catalog and lazy registry", () => {
  it("publishes exactly twelve unique, JSON-serializable manifests", () => {
    expect(operationManifests).toHaveLength(12);
    expect(new Set(operationIds).size).toBe(12);
    expect(JSON.parse(JSON.stringify(operationManifests))).toEqual(
      operationManifests,
    );

    for (const manifest of operationManifests) {
      expect(validateOperationManifest(manifest)).toEqual({
        ok: true,
        value: manifest,
      });
      expect(getOperationManifest(manifest.id)).toBe(manifest);
      expect(Object.isFrozen(manifest)).toBe(true);
      expect(Object.isFrozen(manifest.inputKinds)).toBe(true);
      expect(Object.isFrozen(manifest.outputKinds)).toBe(true);
      expect(Object.isFrozen(manifest.execution)).toBe(true);
      expect(Object.isFrozen(manifest.capabilities)).toBe(true);
      expect(Object.isFrozen(manifest.capabilities.environment)).toBe(true);
      expectDeepFrozen(manifest.options);
      expectDeepFrozen(manifest.signatures);
      expect(
        resolveOperationSignature(
          manifest,
          normalizeOperationOptions(manifest, {}),
        ),
      ).toBeDefined();
    }

    expect(
      operationManifests.map((manifest) => manifest.toolSlug).sort(),
    ).toEqual(enabledTools.map((tool) => tool.slug).sort());
  });

  it("keeps every catalog entry behind one matching lazy loader", async () => {
    expect([...operationLoaderIds].sort()).toEqual([...operationIds].sort());

    for (const operationId of operationIds) {
      const definition = await loadOperationDefinition(operationId);
      expect(definition.manifest).toBe(getOperationManifest(operationId));
      expect(definition.manifest.id).toBe(operationId);
      expect(typeof definition.execute).toBe("function");
    }
  });

  it("rejects unknown Operations without importing a fallback algorithm", async () => {
    await expect(loadOperationDefinition("unknown.operation")).rejects.toEqual(
      expect.objectContaining({
        name: "OperationError",
        code: "unknown-operation",
      }),
    );
  });

  it.each(["__proto__", "constructor", "prototype"])(
    "treats the inherited-looking id %s as a stable unknown Operation",
    async (operationId) => {
      expect(getOperationManifest(operationId)).toBeUndefined();
      await expect(loadOperationDefinition(operationId)).rejects.toMatchObject({
        code: "unknown-operation",
      });
    },
  );

  it("strictly rejects unknown options in every adapter", async () => {
    for (const operationId of operationIds) {
      const definition = await loadOperationDefinition(operationId);
      await expect(
        Promise.resolve().then(() =>
          definition.execute(
            minimalInput(definition),
            { rogueOption: true },
            createContext(),
          ),
        ),
      ).rejects.toMatchObject({
        name: "OperationError",
        code: "invalid-options",
        operationId,
      });
    }
  });

  it("keeps every adapter validator in parity with its option declaration", async () => {
    for (const operationId of operationIds) {
      const definition = await loadOperationDefinition(operationId);
      const defaults = normalizeOperationOptions(definition.manifest, {});
      try {
        await definition.execute(
          minimalInput(definition),
          defaults,
          createContext(),
        );
      } catch (error) {
        expect(error).not.toMatchObject({ code: "invalid-options" });
      }

      for (const [key, schema] of Object.entries(
        definition.manifest.options.properties,
      )) {
        const invalid = { [key]: invalidValueForSchema(schema) };
        expect(() =>
          normalizeOperationOptions(definition.manifest, invalid),
        ).toThrow(expect.objectContaining({ code: "invalid-options" }));
        await expect(
          Promise.resolve().then(() =>
            definition.execute(
              minimalInput(definition),
              invalid,
              createContext(),
            ),
          ),
        ).rejects.toMatchObject({
          name: "OperationError",
          code: "invalid-options",
          operationId,
        });
      }
    }
  });
});

describe("text Operation adapters", () => {
  it("formats and minifies JSON while retaining number lexemes", async () => {
    await expect(
      execute(
        "json.transform",
        { kind: "text", text: '{"value":9007199254740993}' },
        { mode: "format", indent: 4 },
      ),
    ).resolves.toEqual({
      kind: "text",
      text: '{\n    "value": 9007199254740993\n}',
    });

    await expect(
      execute(
        "json.transform",
        { kind: "text", text: '{ "ok" : true }' },
        { mode: "minify" },
      ),
    ).resolves.toEqual({ kind: "text", text: '{"ok":true}' });
  });

  it("encodes and decodes Unicode Base64URL text", async () => {
    const encoded = await execute(
      "base64.codec",
      { kind: "text", text: "中文🙂" },
      { mode: "encode", variant: "url" },
    );
    expect(encoded).toMatchObject({ kind: "text" });
    if (encoded.kind !== "text") throw new Error("Expected text output.");

    await expect(
      execute(
        "base64.codec",
        { kind: "text", text: encoded.text },
        { mode: "decode", variant: "url" },
      ),
    ).resolves.toEqual({ kind: "text", text: "中文🙂" });
  });

  it("applies URL component and form-encoding options", async () => {
    await expect(
      execute(
        "url.codec",
        { kind: "text", text: "a b+c" },
        { mode: "encode", scope: "component", formEncoding: true },
      ),
    ).resolves.toEqual({ kind: "text", text: "a+b%2Bc" });
  });

  it("converts timestamps in both directions as composable JSON text", async () => {
    const timestamp = await execute(
      "timestamp.convert",
      { kind: "text", text: "0" },
      { direction: "timestamp-to-date", unit: "seconds", timeZone: "UTC" },
    );
    expect(timestamp.kind).toBe("text");
    if (timestamp.kind === "text") {
      expect(JSON.parse(timestamp.text)).toMatchObject({
        seconds: 0,
        milliseconds: 0,
        iso: "1970-01-01T00:00:00.000Z",
      });
    }

    const dateTime = await execute(
      "timestamp.convert",
      { kind: "text", text: "1970-01-01T00:00:01" },
      { direction: "date-to-timestamp", interpretation: "utc" },
    );
    expect(dateTime.kind).toBe("text");
    if (dateTime.kind === "text") {
      expect(JSON.parse(dateTime.text)).toMatchObject({ milliseconds: 1_000 });
    }
  });

  it("converts YAML, CSV and query parameters to JSON text", async () => {
    const yaml = await execute(
      "yaml.convert",
      { kind: "text", text: "name: 小明\nactive: true\n" },
      { direction: "yaml-to-json", jsonIndent: 2 },
      "worker",
    );
    expect(yaml.kind === "text" ? JSON.parse(yaml.text) : null).toEqual({
      name: "小明",
      active: true,
    });

    const csv = await execute(
      "csv.convert",
      { kind: "text", text: "name,city\n小明,上海" },
      { direction: "csv-to-json", delimiter: ",", jsonIndent: 2 },
    );
    expect(csv.kind === "text" ? JSON.parse(csv.text) : null).toEqual([
      { name: "小明", city: "上海" },
    ]);

    const query = await execute(
      "query.inspect",
      { kind: "text", text: "?z=2&a=1&a=3" },
      { encoding: "rfc3986", sort: true },
    );
    expect(
      query.kind === "text"
        ? JSON.parse(query.text).parameters.map(
            (parameter: { key: string }) => parameter.key,
          )
        : null,
    ).toEqual(["a", "a", "z"]);
  });

  it("emits unified diff text", async () => {
    const result = await execute(
      "text.diff",
      { kind: "text-pair", left: "first\nold", right: "first\nnew" },
      { ignoreWhitespace: false, ignoreCase: false },
      "worker",
    );
    expect(result).toEqual({
      kind: "text",
      text: "--- 原文\n+++ 新文本\n@@ -1,2 +1,2 @@\n first\n-old\n+new",
    });
  });

  it("decodes JWT metadata as JSON without verifying or networking", async () => {
    const header = encodeBase64('{"alg":"none","typ":"JWT"}', "url");
    const payload = encodeBase64('{"sub":"123","exp":2000000000}', "url");
    const result = await execute(
      "jwt.decode",
      { kind: "text", text: `${header}.${payload}.` },
      { nowMilliseconds: 1_700_000_000_000 },
    );
    expect(result.kind).toBe("text");
    if (result.kind === "text") {
      expect(JSON.parse(result.text)).toMatchObject({
        header: { alg: "none", typ: "JWT" },
        payload: { sub: "123", exp: 2_000_000_000 },
        isUnsigned: true,
      });
    }
  });
});

describe("empty and binary Operation adapters", () => {
  it("generates the requested number of UUID v4 values", async () => {
    const result = await execute(
      "uuid.generate",
      { kind: "empty" },
      { count: 3 },
    );
    expect(result.kind).toBe("text");
    if (result.kind === "text") {
      const values = result.text.split("\n");
      expect(values).toHaveLength(3);
      expect(new Set(values).size).toBe(3);
      for (const value of values) {
        expect(value).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
        );
      }
    }
  });

  it("hashes text and binary with the same Web Crypto core", async () => {
    const text = await execute(
      "hash.digest",
      { kind: "text", text: "abc" },
      { algorithm: "SHA-256" },
    );
    const binary = await execute(
      "hash.digest",
      { kind: "binary", data: new TextEncoder().encode("abc").buffer },
      { algorithm: "SHA-256" },
    );
    expect(text).toEqual(binary);
    expect(text).toEqual({
      kind: "text",
      text: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    });
  });

  it("encodes validated RGBA pixels into a PNG binary payload", async () => {
    const hadOwnWindowAlias = Object.hasOwn(globalThis, "window");
    const result = await execute(
      "image.rgba-to-png",
      {
        kind: "rgba-image",
        width: 1,
        height: 1,
        data: new Uint8ClampedArray([255, 0, 0, 255]),
      },
      { paletteColors: 2 },
      "worker",
    );
    expect(result.kind).toBe("binary");
    if (result.kind === "binary") {
      expect(result.mimeType).toBe("image/png");
      expect([...new Uint8Array(result.data).slice(0, 8)]).toEqual(
        PNG_SIGNATURE,
      );
    }
    expect(Object.hasOwn(globalThis, "window")).toBe(hadOwnWindowAlias);
  });
});

describe("adapter error normalization", () => {
  it("maps unavailable cryptographic capabilities to a stable environment error", async () => {
    vi.stubGlobal("crypto", undefined);

    await expect(
      execute("uuid.generate", { kind: "empty" }),
    ).rejects.toMatchObject({
      code: "unsupported-environment",
      operationId: "uuid.generate",
      details: { sourceCode: "crypto-unavailable" },
    });
    await expect(
      execute("hash.digest", { kind: "text", text: "abc" }),
    ).rejects.toMatchObject({
      code: "unsupported-environment",
      operationId: "hash.digest",
      details: { sourceCode: "crypto-unavailable" },
    });
  });

  it("maps core validation failures to OperationError", async () => {
    await expect(
      execute("json.transform", { kind: "text", text: "{" }),
    ).rejects.toMatchObject({
      name: "OperationError",
      code: "execution-failed",
      operationId: "json.transform",
      details: { offset: 1, line: 1 },
    });
  });

  it("rejects wrong input kinds and invalid option ranges", async () => {
    await expect(
      execute("json.transform", { kind: "empty" }),
    ).rejects.toBeInstanceOf(OperationError);

    await expect(
      execute(
        "image.rgba-to-png",
        {
          kind: "rgba-image",
          width: 1,
          height: 1,
          data: new Uint8ClampedArray(4),
        },
        { paletteColors: 1 },
        "worker",
      ),
    ).rejects.toMatchObject({ code: "invalid-options" });
  });

  it("rejects RGBA buffers that do not match validated dimensions", async () => {
    await expect(
      execute(
        "image.rgba-to-png",
        {
          kind: "rgba-image",
          width: 2,
          height: 2,
          data: new Uint8ClampedArray(4),
        },
        { paletteColors: 16 },
        "worker",
      ),
    ).rejects.toMatchObject({
      code: "execution-failed",
      operationId: "image.rgba-to-png",
      details: { sourceCode: "invalid-rgba-length" },
    });
  });

  it("never copies input text into a serializable Operation error", async () => {
    const secret = "OPERATION_PRIVATE_CANARY_9f31";
    const header = encodeBase64('{"alg":"none"}', "url");
    const malformedPayload = encodeBase64(
      `{"message":"${secret}",broken}`,
      "url",
    );

    try {
      await execute("jwt.decode", {
        kind: "text",
        text: `${header}.${malformedPayload}.`,
      });
      throw new Error("Expected JWT decoding to fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(OperationError);
      const serialized = (error as OperationError).toJSON();
      expect(JSON.stringify(serialized)).not.toContain(secret);
      expect(serialized).toMatchObject({
        code: "execution-failed",
        operationId: "jwt.decode",
        details: { sourceCode: "INVALID_JSON" },
      });
    }
  });

  it("does not echo unknown option names into serializable errors", async () => {
    const secretKey = "OPERATION_OPTION_CANARY_d72c";

    try {
      await execute(
        "json.transform",
        { kind: "text", text: "{}" },
        { [secretKey]: true },
      );
      throw new Error("Expected unknown options to fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(OperationError);
      expect(JSON.stringify((error as OperationError).toJSON())).not.toContain(
        secretKey,
      );
      expect(error).toMatchObject({
        code: "invalid-options",
        details: { unknownKeyCount: 1 },
      });
    }
  });
});

import { describe, expect, it } from "vitest";

import {
  detectSmartImage,
  detectSmartText,
  getUtf8ByteLength,
  MAX_SMART_IMAGE_BYTES,
  MAX_SMART_INPUT_BYTES,
} from "../../src/lib/smart-input-detection";

describe("smart input text detection", () => {
  it("keeps the empty state instructive and never invents a recommendation", () => {
    expect(detectSmartText(" \n\t")).toEqual({
      state: "empty",
      message: expect.stringContaining("不会读取你的剪贴板"),
      recommendations: [],
    });
  });

  it.each([
    {
      input: '{"project":"hub","ready":true}',
      kind: "json",
      firstSlug: "json-formatter",
    },
    {
      input:
        "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJzdWIiOiIxMjMiLCJleHAiOjE5MDAwMDAwMDB9.signature",
      kind: "jwt",
      firstSlug: "jwt-decoder",
    },
    {
      input: "https://example.com/search?q=%E4%BD%A0%E5%A5%BD&tag=a&tag=b",
      kind: "url",
      firstSlug: "query-params",
    },
    {
      input: "?q=hello&empty=&tag=a&tag=b",
      kind: "query",
      firstSlug: "query-params",
    },
    {
      input: "1710000000",
      kind: "timestamp",
      firstSlug: "unix-timestamp",
    },
    {
      input: "1710000000000",
      kind: "timestamp",
      firstSlug: "unix-timestamp",
    },
    {
      input: "name,ready\nhub,true\ntools,12",
      kind: "csv",
      firstSlug: "csv-json-converter",
    },
    {
      input: "name\tready\nhub\ttrue\ntools\t12",
      kind: "tsv",
      firstSlug: "csv-json-converter",
    },
    {
      input: "project: hub\nprivacy: local\nready: true",
      kind: "yaml",
      firstSlug: "yaml-json-converter",
    },
    {
      input: "5L2g5aW9",
      kind: "base64",
      firstSlug: "base64-codec",
    },
    {
      input: "SGVsbG8=",
      kind: "base64",
      firstSlug: "base64-codec",
    },
    {
      input: "SGVsbG8td29ybGRf",
      kind: "base64",
      firstSlug: "base64-codec",
    },
  ])("recognizes $kind conservatively", ({ input, kind, firstSlug }) => {
    const result = detectSmartText(input);

    expect(result).toMatchObject({ state: "detected", kind });
    expect(result.recommendations[0]).toEqual({
      slug: firstSlug,
      reason: expect.any(String),
    });
    expect(result.recommendations.length).toBeLessThanOrEqual(3);
  });

  it("recommends table conversion only for a JSON object array", () => {
    const result = detectSmartText('[{"name":"A"},{"name":"B"}]');

    expect(result.state).toBe("detected");
    expect(result.recommendations.map(({ slug }) => slug)).toEqual([
      "json-formatter",
      "yaml-json-converter",
      "csv-json-converter",
    ]);
  });

  it("keeps a URL without query parameters focused on URL encoding", () => {
    const result = detectSmartText(
      "https://example.com/docs/getting-started#api",
    );

    expect(result).toMatchObject({ state: "detected", kind: "url" });
    expect(result.recommendations.map(({ slug }) => slug)).toEqual([
      "url-codec",
    ]);
  });

  it("handles quoted CSV fields, escaped quotes and CRLF rows", () => {
    const result = detectSmartText(
      'name,note\r\nAlice,"said ""hello"""\r\nBob,"ready, now"',
    );

    expect(result).toMatchObject({
      state: "detected",
      kind: "csv",
      message: expect.stringContaining("3 行、2 列"),
    });
  });

  it("rejects JWT-like strings whose decoded payload is not JSON", () => {
    expect(
      detectSmartText("eyJhbGciOiJub25l.bm90LWpzb24.signature"),
    ).toMatchObject({ state: "unknown" });
  });

  it("does not misclassify arbitrary prose or malformed tabular data", () => {
    expect(detectSmartText("这只是一段普通文本，没有明确格式。")).toMatchObject(
      {
        state: "unknown",
        recommendations: [],
      },
    );
    expect(detectSmartText("name,value\nonly-one-column")).toMatchObject({
      state: "unknown",
    });
    expect(detectSmartText('name,value\n"unfinished')).toMatchObject({
      state: "unknown",
    });
  });

  it("distinguishes padded Base64 from ordinary single query pairs", () => {
    expect(detectSmartText("dGVzdA==")).toMatchObject({
      state: "detected",
      kind: "base64",
    });
    for (const query of [
      "a=b",
      "flag=",
      "tokenid=",
      "?dGVzdA==",
      "payload=SGVsbG8=&x=1",
    ]) {
      expect(detectSmartText(query)).toMatchObject({
        state: "detected",
        kind: "query",
      });
    }
  });

  it("measures UTF-8 bytes and rejects text above the two MiB boundary", () => {
    expect(getUtf8ByteLength("你🙂")).toBe(7);
    expect(detectSmartText("a".repeat(MAX_SMART_INPUT_BYTES))).toMatchObject({
      state: "unknown",
      byteLength: MAX_SMART_INPUT_BYTES,
    });
    expect(
      detectSmartText("a".repeat(MAX_SMART_INPUT_BYTES + 1)),
    ).toMatchObject({
      state: "too-large",
      byteLength: MAX_SMART_INPUT_BYTES + 1,
      recommendations: [],
    });
  });

  it("returns classifications and reasons without echoing sensitive input", () => {
    const canary = "OTH_PRIVATE_CANARY_123";
    const result = detectSmartText(
      JSON.stringify({ token: canary, nested: { ready: true } }),
    );

    expect(JSON.stringify(result)).not.toContain(canary);
    expect(result).toMatchObject({ state: "detected", kind: "json" });
  });

  it("prioritizes JSON objects and arrays containing query delimiters", () => {
    for (const input of [
      JSON.stringify({ private: "canary?&", token: "a=b" }),
      JSON.stringify([{ callback: "?ready=true&mode=local" }]),
    ]) {
      expect(detectSmartText(input)).toMatchObject({
        state: "detected",
        kind: "json",
      });
    }
  });
});

describe("smart input image detection", () => {
  const pngSignature = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
  ]);
  const jpegSignature = new Uint8Array([
    0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0,
  ]);
  const webpSignature = new Uint8Array([
    0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
  ]);

  it.each([
    { format: "png", type: "image/png", signature: pngSignature },
    { format: "jpeg", type: "image/jpeg", signature: jpegSignature },
    { format: "webp", type: "image/webp", signature: webpSignature },
  ])(
    "trusts $format signature bytes, not the filename",
    ({ format, type, signature }) => {
      const result = detectSmartImage({
        name: "renamed.bin",
        type,
        size: 1024,
        signature,
      });

      expect(result).toMatchObject({
        state: "detected",
        kind: "image",
        format,
        recommendations: [
          { slug: "image-compressor", reason: expect.any(String) },
          { slug: "hash-generator", reason: expect.any(String) },
        ],
      });
    },
  );

  it("reports MIME/signature mismatch without rejecting a real image", () => {
    const result = detectSmartImage({
      name: "photo.jpg",
      type: "image/jpeg",
      size: 2048,
      signature: pngSignature,
    });

    expect(result).toMatchObject({ state: "detected", format: "png" });
    expect(result.message).toContain("以签名为准");
  });

  it("accepts a missing MIME label when signature bytes are valid", () => {
    const result = detectSmartImage({
      name: "download",
      type: "",
      size: 2 * 1024 * 1024,
      signature: pngSignature,
    });

    expect(result).toMatchObject({ state: "detected", format: "png" });
    expect(result.message).toContain("2.00 MiB");
  });

  it("rejects empty, oversized and unsupported files before recommending", () => {
    expect(
      detectSmartImage({
        name: "empty.png",
        type: "image/png",
        size: 0,
        signature: pngSignature,
      }),
    ).toMatchObject({ state: "error", recommendations: [] });

    expect(
      detectSmartImage({
        name: "large.png",
        type: "image/png",
        size: MAX_SMART_IMAGE_BYTES + 1,
        signature: pngSignature,
      }),
    ).toMatchObject({ state: "error", recommendations: [] });

    expect(
      detectSmartImage({
        name: "not-an-image.png",
        type: "image/png",
        size: 10,
        signature: new Uint8Array(12),
      }),
    ).toMatchObject({
      state: "error",
      message: expect.stringContaining("签名字节"),
      recommendations: [],
    });
  });
});

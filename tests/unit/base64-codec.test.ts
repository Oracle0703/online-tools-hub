import { describe, expect, it } from "vitest";

import {
  decodeBase64,
  encodeBase64,
  type Base64DecodeErrorCode,
  type Base64Variant,
} from "../../src/tools/base64-codec";

// Fixed interoperability vectors. The first seven are the RFC 4648 section 10
// vectors; the remainder cover UTF-8, controls, line endings, and both symbols
// that differ in the Base64URL alphabet.
const STANDARD_VECTORS = [
  ["", ""],
  ["f", "Zg=="],
  ["fo", "Zm8="],
  ["foo", "Zm9v"],
  ["foob", "Zm9vYg=="],
  ["fooba", "Zm9vYmE="],
  ["foobar", "Zm9vYmFy"],
  ["hello", "aGVsbG8="],
  ["Hello, world!", "SGVsbG8sIHdvcmxkIQ=="],
  ["中文", "5Lit5paH"],
  ["😀", "8J+YgA=="],
  ["Hello, 世界!", "SGVsbG8sIOS4lueVjCE="],
  ["\u0000", "AA=="],
  ["\n", "Cg=="],
  ["a\nb", "YQpi"],
  ["👩‍💻", "8J+RqeKAjfCfkrs="],
  ["✓ à la mode", "4pyTIMOgIGxhIG1vZGU="],
  ["~~~", "fn5+"],
  ["???", "Pz8/"],
  ["你好，世界", "5L2g5aW977yM5LiW55WM"],
  ["\r\n", "DQo="],
  ["\t", "CQ=="],
  ["é", "w6k="],
  ["𠜎", "8KCcjg=="],
] as const;

describe("encodeBase64", () => {
  it.each(STANDARD_VECTORS)(
    "encodes the fixed UTF-8 vector %j",
    (plainText, encoded) => {
      expect(encodeBase64(plainText)).toBe(encoded);
    },
  );

  it.each([
    ["f", "Zg"],
    ["fo", "Zm8"],
    ["foo", "Zm9v"],
    ["~~~", "fn5-"],
    ["???", "Pz8_"],
    ["😀", "8J-YgA"],
  ] as const)("emits unpadded Base64URL for %j", (plainText, encoded) => {
    expect(encodeBase64(plainText, "url")).toBe(encoded);
  });

  it.each(["\ud800", "x\udfff", "a\ud800b"])(
    "rejects an unpaired UTF-16 surrogate in %j instead of replacing it",
    (input) => {
      expect(() => encodeBase64(input)).toThrow("未配对的代理字符");
    },
  );
});

describe("decodeBase64", () => {
  it.each(STANDARD_VECTORS)(
    "decodes the fixed UTF-8 vector %j",
    (plainText, encoded) => {
      expect(decodeBase64(encoded)).toEqual({ ok: true, value: plainText });
    },
  );

  it.each([
    ["Zg", "f"],
    ["Zg==", "f"],
    ["Zm8", "fo"],
    ["Zm8=", "fo"],
    ["fn5-", "~~~"],
    ["Pz8_", "???"],
    ["8J-YgA", "😀"],
  ] as const)(
    "decodes padded or unpadded Base64URL %s",
    (encoded, plainText) => {
      expect(decodeBase64(encoded, "url")).toEqual({
        ok: true,
        value: plainText,
      });
    },
  );

  it("preserves embedded NUL bytes and line breaks", () => {
    const source = "before\u0000middle\r\nafter\n";
    const encoded = encodeBase64(source);

    expect(decodeBase64(encoded)).toEqual({ ok: true, value: source });
  });

  it.each([
    ["A", "standard", "INVALID_LENGTH"],
    ["Zg", "standard", "INVALID_PADDING"],
    ["Zg=", "standard", "INVALID_PADDING"],
    ["Zg===", "standard", "INVALID_PADDING"],
    ["=m9v", "standard", "INVALID_PADDING"],
    ["Zm=v", "standard", "INVALID_PADDING"],
    ["Zm9v=", "standard", "INVALID_PADDING"],
    ["Zm 9v", "standard", "INVALID_CHARACTER"],
    ["Zm9v\n", "standard", "INVALID_CHARACTER"],
    ["Zm9v-", "standard", "INVALID_CHARACTER"],
    ["Zm9v_", "standard", "INVALID_CHARACTER"],
    ["Zm$v", "standard", "INVALID_CHARACTER"],
    ["Zh==", "standard", "NON_CANONICAL_ENCODING"],
    ["Zm9=", "standard", "NON_CANONICAL_ENCODING"],
    ["A", "url", "INVALID_LENGTH"],
    ["Zg=", "url", "INVALID_PADDING"],
    ["Zg===", "url", "INVALID_PADDING"],
    ["Zg+/", "url", "INVALID_CHARACTER"],
    ["Zg/=", "url", "INVALID_CHARACTER"],
    ["Zh", "url", "NON_CANONICAL_ENCODING"],
    ["Zm9", "url", "NON_CANONICAL_ENCODING"],
  ] as const)(
    "rejects malformed %s input for the %s alphabet",
    (input, variant, code) => {
      const result = decodeBase64(input, variant as Base64Variant);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(code as Base64DecodeErrorCode);
        expect(result.error.message.length).toBeGreaterThan(0);
      }
    },
  );

  it.each([
    ["/w==", "standard"],
    ["wK8=", "standard"],
    ["7aCA", "standard"],
    ["8A==", "standard"],
    ["_w", "url"],
  ] as const)("rejects invalid UTF-8 bytes from %s", (input, variant) => {
    const result = decodeBase64(input, variant);

    expect(result).toEqual({
      ok: false,
      error: {
        code: "INVALID_UTF8",
        message: "Base64 数据不是有效的 UTF-8 文本，无法安全显示。",
      },
    });
  });
});

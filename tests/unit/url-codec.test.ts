import { describe, expect, it } from "vitest";

import {
  decodeFullUrl,
  decodeUrlComponent,
  encodeFullUrl,
  encodeUrlComponent,
  transformUrl,
} from "../../src/tools/url-codec";

describe("URL component codec", () => {
  it.each([
    ["hello world", "hello%20world", false],
    ["a+b", "a%2Bb", false],
    ["100%", "100%25", false],
    ["中文", "%E4%B8%AD%E6%96%87", false],
    ["😀", "%F0%9F%98%80", false],
    ["a/b?c=d&e", "a%2Fb%3Fc%3Dd%26e", false],
    ["email@example.com", "email%40example.com", false],
    ["a b+c", "a+b%2Bc", true],
    ["", "", false],
  ] as const)(
    "encodes %j with formEncoding=%s",
    (input, expected, formEncoding) => {
      expect(encodeUrlComponent(input, { formEncoding })).toEqual({
        ok: true,
        value: expected,
      });
    },
  );

  it.each([
    ["hello%20world", "hello world", false],
    ["a%2Bb", "a+b", false],
    ["a+b", "a+b", false],
    ["a+b", "a b", true],
    ["a%2Bb+c", "a+b c", true],
    ["%E4%B8%AD%E6%96%87", "中文", false],
    ["%C3%A9%E2%82%AC", "é€", false],
    ["%F0%9F%98%80", "😀", false],
    ["a%2Fb%3Fc%3Dd%26e", "a/b?c=d&e", false],
  ] as const)(
    "decodes %j with formEncoding=%s",
    (input, expected, formEncoding) => {
      expect(decodeUrlComponent(input, { formEncoding })).toEqual({
        ok: true,
        value: expected,
      });
    },
  );

  it.each([
    ["%", 1, 1, "两个十六进制"],
    ["%2", 1, 1, "两个十六进制"],
    ["%GG", 1, 1, "两个十六进制"],
    ["ok%2G", 1, 3, "两个十六进制"],
    ["%E0%A4%A", 1, 7, "两个十六进制"],
    ["%C0%AF", 1, 1, "UTF-8"],
    ["ok%20%C0%AF", 1, 6, "UTF-8"],
    ["%E0%80%80", 1, 1, "UTF-8"],
    ["%F4%90%80%80", 1, 1, "UTF-8"],
    ["%F5%80%80%80", 1, 1, "UTF-8"],
    ["%E4%B8", 1, 1, "UTF-8"],
    ["ok\n%GG", 2, 1, "两个十六进制"],
  ] as const)(
    "reports malformed component %j at line %i column %i",
    (input, line, column, message) => {
      const result = decodeUrlComponent(input);
      expect(result.ok).toBe(false);

      if (!result.ok) {
        expect(result.error).toMatchObject({ line, column });
        expect(result.error.message).toContain(message);
        expect(result.error.pointer).toContain("^");
      }
    },
  );

  it.each(["\ud800", "x\udfff", "a\ud800b"])(
    "returns an error for an unpaired surrogate in %j",
    (input) => {
      const result = encodeUrlComponent(input);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("Unicode");
      }
    },
  );
});

describe("full URL codec", () => {
  it.each([
    [
      "https://example.com/a b?q=hello world&x=1#top",
      "https://example.com/a%20b?q=hello%20world&x=1#top",
      false,
    ],
    [
      "https://例子.测试/中文?q=工具#说明",
      "https://%E4%BE%8B%E5%AD%90.%E6%B5%8B%E8%AF%95/%E4%B8%AD%E6%96%87?q=%E5%B7%A5%E5%85%B7#%E8%AF%B4%E6%98%8E",
      false,
    ],
    [
      "https://example.com/already%20encoded?q=%E4%B8%AD",
      "https://example.com/already%20encoded?q=%E4%B8%AD",
      false,
    ],
    [
      "https://example.com/100% ready",
      "https://example.com/100%25%20ready",
      false,
    ],
    ["https://example.com/a+b?q=a+b", "https://example.com/a+b?q=a+b", false],
    [
      "https://x.test/a+b?q=a b+c#x+y",
      "https://x.test/a+b?q=a+b%2Bc#x+y",
      true,
    ],
    [
      "/relative path?name=张 三",
      "/relative%20path?name=%E5%BC%A0%20%E4%B8%89",
      false,
    ],
    [
      "http://[2001:db8::1]/a b?q=中文",
      "http://[2001:db8::1]/a%20b?q=%E4%B8%AD%E6%96%87",
      false,
    ],
  ] as const)(
    "encodes a full URL without changing its structure",
    (input, expected, formEncoding) => {
      expect(encodeFullUrl(input, { formEncoding })).toEqual({
        ok: true,
        value: expected,
      });
    },
  );

  it.each([
    [
      "https://example.com/%E4%B8%AD?q=a%20b#%E8%AF%B4",
      "https://example.com/中?q=a b#说",
      false,
    ],
    [
      "https://example.com/a%2Fb?q=x%26y%3Dz#one%23two",
      "https://example.com/a%2Fb?q=x%26y%3Dz#one%23two",
      false,
    ],
    ["https://x.test/a%2Bb?q=a%2Bb", "https://x.test/a+b?q=a+b", false],
    ["https://x.test/a+b?q=a+b#x+y", "https://x.test/a+b?q=a+b#x+y", false],
    ["https://x.test/a+b?q=a+b#x+y", "https://x.test/a+b?q=a b#x+y", true],
    ["https://x.test/search?q=a%2Bb+c", "https://x.test/search?q=a+b c", true],
    ["/relative%20path?name=%E5%BC%A0", "/relative path?name=张", false],
    [
      "https://example.com/中文?q=plain",
      "https://example.com/中文?q=plain",
      false,
    ],
  ] as const)(
    "decodes a full URL while keeping escaped delimiters",
    (input, expected, formEncoding) => {
      expect(decodeFullUrl(input, { formEncoding })).toEqual({
        ok: true,
        value: expected,
      });
    },
  );

  it("reports invalid percent escapes without throwing", () => {
    const result = decodeFullUrl("https://example.com/%ZZ?q=ok");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject({ line: 1, column: 21 });
      expect(result.error.message).toContain("百分号转义");
    }
  });

  it("reports percent sequences that are not valid UTF-8", () => {
    const result = decodeFullUrl("https://example.com/%ED%A0%80");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("UTF-8");
    }
  });

  it("does not double-encode valid percent escapes but escapes a stray percent", () => {
    expect(encodeFullUrl("/%2f/%oops")).toEqual({
      ok: true,
      value: "/%2f/%25oops",
    });
  });

  it("keeps IPv6 authority brackets so the encoded URL remains parseable", () => {
    const result = encodeFullUrl("https://[2001:db8::1]/a b");

    expect(result).toEqual({
      ok: true,
      value: "https://[2001:db8::1]/a%20b",
    });
    if (result.ok) {
      expect(new URL(result.value).hostname).toBe("[2001:db8::1]");
    }
  });
});

describe("transformUrl", () => {
  it.each([
    ["encode", "component", "a b", "a%20b"],
    ["decode", "component", "a%20b", "a b"],
    ["encode", "url", "https://x.test/a b", "https://x.test/a%20b"],
    ["decode", "url", "https://x.test/a%20b", "https://x.test/a b"],
  ] as const)(
    "dispatches %s in %s mode",
    (operation, mode, input, expected) => {
      expect(transformUrl(input, operation, mode)).toEqual({
        ok: true,
        value: expected,
      });
    },
  );
});

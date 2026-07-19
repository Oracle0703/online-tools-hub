import { describe, expect, it } from "vitest";

import {
  formatJson,
  minifyJson,
  validateJson,
} from "../../src/tools/json-formatter";

describe("formatJson", () => {
  it("formats nested values with two spaces by default", () => {
    expect(formatJson('{"name":"工具","items":[1,true,null]}')).toEqual({
      ok: true,
      value: [
        "{",
        '  "name": "工具",',
        '  "items": [',
        "    1,",
        "    true,",
        "    null",
        "  ]",
        "}",
      ].join("\n"),
    });
  });

  it.each([
    [2, "  "],
    [4, "    "],
    ["tab", "\t"],
  ] as const)("supports %s indentation", (indent, whitespace) => {
    const result = formatJson('{"outer":{"value":1}}', indent);
    expect(result).toEqual({
      ok: true,
      value: [
        "{",
        `${whitespace}"outer": {`,
        `${whitespace}${whitespace}"value": 1`,
        `${whitespace}}`,
        "}",
      ].join("\n"),
    });
  });

  it.each([
    "9007199254740993",
    "-900719925474099312345678901234567890",
    "1.2300",
    "6.022E+23",
    "1e-0007",
  ])("preserves the numeric lexeme %s", (number) => {
    const input = `{"number":${number}}`;
    const result = formatJson(input);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toContain(number);
    }
  });

  it("preserves duplicate object keys and string escape spelling", () => {
    expect(formatJson('{"a":"\\u0041","a":"\\/"}')).toEqual({
      ok: true,
      value: '{\n  "a": "\\u0041",\n  "a": "\\/"\n}',
    });
  });

  it("keeps HTML-like injection content as an inert JSON string lexeme", () => {
    const payload = "</script><img src=x onerror=alert(1)>";
    expect(formatJson(JSON.stringify({ payload }))).toEqual({
      ok: true,
      value: `{\n  "payload": ${JSON.stringify(payload)}\n}`,
    });
  });

  it("returns a structured error instead of throwing", () => {
    const result = formatJson('{"missing":');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject({ line: 1, column: 12 });
    }
  });

  it.each([
    ["{}", "{}"],
    ["[]", "[]"],
    ['"text"', '"text"'],
    [" true ", "true"],
    ["\r\n\t null \t", "null"],
  ])("formats root value %s", (input, expected) => {
    expect(formatJson(input)).toEqual({ ok: true, value: expected });
  });
});

describe("minifyJson", () => {
  it("removes only insignificant whitespace", () => {
    const input = `{
      "message": "spaces stay here",
      "nested": [ 1, { "ok": true } ]
    }`;
    expect(minifyJson(input)).toEqual({
      ok: true,
      value: '{"message":"spaces stay here","nested":[1,{"ok":true}]}',
    });
  });

  it("preserves whitespace escaped or contained inside strings", () => {
    expect(minifyJson('{ "value": "a b\\n\\t" }')).toEqual({
      ok: true,
      value: '{"value":"a b\\n\\t"}',
    });
  });

  it("preserves a large integer exactly", () => {
    const integer = "1844674407370955161518446744073709551615";
    expect(minifyJson(`[ ${integer} ]`)).toEqual({
      ok: true,
      value: `[${integer}]`,
    });
  });
});

describe("validateJson", () => {
  it.each([
    "null",
    "true",
    "false",
    "0",
    "-0",
    "-12.5e+2",
    '"emoji 😀"',
    '"\\"\\\\\\/\\b\\f\\n\\r\\t"',
    '"\\u00e9"',
    "[]",
    "{}",
    '[1,"two",false,null]',
    '{"a":1,"b":{"c":[]}}',
  ])("accepts valid JSON: %s", (input) => {
    expect(validateJson(input)).toEqual({ ok: true });
  });

  it.each([
    ["", 1, 1, "empty"],
    ["   \t", 1, 5, "empty"],
    ["undefined", 1, 1, "Unexpected token"],
    ["True", 1, 1, "Unexpected token"],
    ["01", 1, 2, "Leading zeros"],
    ["-", 1, 2, "after '-'"],
    ["1.", 1, 3, "decimal point"],
    ["1e+", 1, 4, "exponent"],
    ['"unterminated', 1, 14, "Unterminated string"],
    ['"unterminated\\', 1, 15, "Unterminated escape"],
    ['"bad\\x"', 1, 6, "Invalid escape"],
    ['"bad\\u12x4"', 1, 9, "four hexadecimal"],
    ['"line\nbreak"', 1, 6, "control character"],
    ["[1,]", 1, 4, "expected a JSON value"],
    ['{"a":1,}', 1, 8, "object key"],
    ['{"a" 1}', 1, 6, "after the object key"],
    ['{"a":1 "b":2}', 1, 8, "after the object value"],
    ["[1 2]", 1, 4, "after the array item"],
    ["{}{}", 1, 3, "after the JSON value"],
    ["NaN", 1, 1, "Unexpected token"],
    ["Infinity", 1, 1, "Unexpected token"],
    ["'single quotes'", 1, 1, "Unexpected token"],
  ])(
    "rejects %s with a location and context",
    (input, line, column, message) => {
      const result = validateJson(input);
      expect(result.ok).toBe(false);

      if (!result.ok) {
        expect(result.error).toMatchObject({ line, column });
        expect(result.error.message).toContain(message);
        expect(result.error.offset).toBeGreaterThanOrEqual(0);
        expect(result.error.pointer).toContain("^");
        expect(result.error.context.length).toBeLessThanOrEqual(80);
      }
    },
  );

  it("reports the exact line, Unicode-aware column, and nearby source", () => {
    const result = validateJson('{\n  "😀": true,\n  "broken": nope\n}');
    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.error).toMatchObject({
        line: 3,
        column: 14,
        context: '  "broken": nope',
        pointer: "             ^",
      });
    }
  });

  it("keeps the excerpt bounded around errors on long lines", () => {
    const prefix = `{"${"a".repeat(100)}":`;
    const result = validateJson(`${prefix}?}`);
    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.error.context.length).toBeLessThanOrEqual(80);
      expect(result.error.pointer).toBe(`${" ".repeat(32)}^`);
    }
  });

  it("treats CRLF as one newline", () => {
    const result = validateJson('{\r\n  "value": ?\r\n}');
    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.error).toMatchObject({ line: 2, column: 12 });
    }
  });
});

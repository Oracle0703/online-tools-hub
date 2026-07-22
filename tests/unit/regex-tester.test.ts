import { describe, expect, it } from "vitest";

import {
  REGEX_TESTER_LIMITS,
  serializeRegexTestSuccess,
  testRegularExpression,
} from "../../src/tools/regex-tester";

function expectFailure(
  result: ReturnType<typeof testRegularExpression>,
  code: string,
) {
  expect(result).toMatchObject({ ok: false, error: { code } });
  if (result.ok) throw new Error(`Expected ${code} failure.`);
  return result.error;
}

describe("regex tester core", () => {
  it("enforces the published input, match, capture and output limits", () => {
    expect(REGEX_TESTER_LIMITS).toMatchObject({
      maxPatternBytes: 8 * 1024,
      maxSubjectBytes: 256 * 1024,
      maxMatches: 1_000,
      maxCapturesPerMatch: 256,
      maxOutputBytes: 2 * 1024 * 1024,
    });

    expectFailure(
      testRegularExpression(
        { pattern: "界".repeat(3), flags: "", subject: "" },
        { maxPatternBytes: 8 },
      ),
      "pattern-too-large",
    );
    expectFailure(
      testRegularExpression(
        { pattern: ".", flags: "", subject: "🙂🙂" },
        { maxSubjectBytes: 7 },
      ),
      "subject-too-large",
    );
    expectFailure(
      testRegularExpression(
        { pattern: "(a)(b)", flags: "", subject: "ab" },
        { maxCapturesPerMatch: 1 },
      ),
      "too-many-captures",
    );
    expectFailure(
      testRegularExpression(
        { pattern: ".", flags: "", subject: "a" },
        { maxOutputBytes: 64 },
      ),
      "output-too-large",
    );
  });

  it.each([
    ["gg", "重复标志"],
    ["x", "未知标志"],
    ["uv", "互斥 Unicode 标志"],
    ["gimsvuygg", "过长标志"],
  ])("rejects %s as %s", (flags) => {
    const error = expectFailure(
      testRegularExpression({ pattern: ".", flags, subject: "a" }),
      "invalid-flags",
    );
    expect(error.field).toBe("flags");
    expect(error.message).not.toContain(flags);
  });

  it("returns a fixed compilation error without echoing the pattern", () => {
    const secret = "PRIVATE_PATTERN_CANARY_75d1";
    const result = testRegularExpression({
      pattern: `${secret}(`,
      flags: "",
      subject: "",
    });
    const error = expectFailure(result, "invalid-pattern");

    expect(error).toEqual({
      code: "invalid-pattern",
      field: "pattern",
      message: "正则表达式语法无效，请检查括号、字符类与转义。",
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it.each(["g", "gu"])(
    "advances zero-width matches by Unicode code point with %s flags",
    (flags) => {
      const result = testRegularExpression({
        pattern: "(?=.)",
        flags,
        subject: "🙂a",
      });

      expect(result).toMatchObject({
        ok: true,
        matches: [
          { ordinal: 1, index: 0, end: 0, text: "" },
          { ordinal: 2, index: 2, end: 2, text: "" },
        ],
      });
    },
  );

  it("returns positional, numbered and sorted named captures", () => {
    const result = testRegularExpression({
      pattern: String.raw`(?<word>\p{L}+)(?:-(?<digits>\d+))?`,
      flags: "u",
      subject: "工具",
    });

    expect(result).toMatchObject({
      ok: true,
      patternBytes: 35,
      subjectBytes: 6,
      flags: "u",
      truncated: false,
      matches: [
        {
          ordinal: 1,
          index: 0,
          end: 2,
          text: "工具",
          captures: ["工具", null],
          namedCaptures: [
            { name: "digits", value: null },
            { name: "word", value: "工具" },
          ],
        },
      ],
    });
    if (!result.ok) throw new Error("Expected a successful regex result.");
    expect(result.outputBytes).toBe(
      new TextEncoder().encode(serializeRegexTestSuccess(result)).byteLength,
    );
  });

  it("stops at the match limit and marks the result as truncated", () => {
    const result = testRegularExpression(
      { pattern: ".", flags: "gu", subject: "a🙂b" },
      { maxMatches: 2 },
    );

    expect(result).toMatchObject({
      ok: true,
      truncated: true,
      matchLimit: 2,
      matches: [
        { ordinal: 1, index: 0, end: 1, text: "a" },
        { ordinal: 2, index: 1, end: 3, text: "🙂" },
      ],
    });
  });

  it("does not report truncation when the final match exactly meets the limit", () => {
    const result = testRegularExpression(
      { pattern: ".", flags: "g", subject: "ab" },
      { maxMatches: 2 },
    );

    expect(result).toMatchObject({
      ok: true,
      truncated: false,
      matchLimit: 2,
      matches: [
        { ordinal: 1, index: 0, end: 1, text: "a" },
        { ordinal: 2, index: 1, end: 2, text: "b" },
      ],
    });
  });
});

import {
  getRegexTextByteLength,
  REGEX_TESTER_LIMITS,
  SUPPORTED_REGEX_FLAGS,
  type RegexMatchResult,
  type RegexTestError,
  type RegexTestFailure,
  type RegexTestInput,
  type RegexTestResult,
  type RegexTestSuccess,
} from "./contract";

export interface RegexTestLimitOverrides {
  readonly maxPatternBytes?: number;
  readonly maxSubjectBytes?: number;
  readonly maxMatches?: number;
  readonly maxCapturesPerMatch?: number;
  readonly maxOutputBytes?: number;
}

const encoder = new TextEncoder();
const supportedFlags = new Set<string>(SUPPORTED_REGEX_FLAGS);

function boundedPositiveInteger(value: number | undefined, fallback: number) {
  return Number.isSafeInteger(value) && Number(value) > 0
    ? Math.min(Number(value), fallback)
    : fallback;
}

function normalizedLimits(overrides: RegexTestLimitOverrides = {}) {
  return {
    maxPatternBytes: boundedPositiveInteger(
      overrides.maxPatternBytes,
      REGEX_TESTER_LIMITS.maxPatternBytes,
    ),
    maxSubjectBytes: boundedPositiveInteger(
      overrides.maxSubjectBytes,
      REGEX_TESTER_LIMITS.maxSubjectBytes,
    ),
    maxMatches: boundedPositiveInteger(
      overrides.maxMatches,
      REGEX_TESTER_LIMITS.maxMatches,
    ),
    maxCapturesPerMatch: boundedPositiveInteger(
      overrides.maxCapturesPerMatch,
      REGEX_TESTER_LIMITS.maxCapturesPerMatch,
    ),
    maxOutputBytes: boundedPositiveInteger(
      overrides.maxOutputBytes,
      REGEX_TESTER_LIMITS.maxOutputBytes,
    ),
  };
}

function failure(error: RegexTestError): RegexTestFailure {
  return { ok: false, error };
}

function validateFlags(flags: string): RegexTestError | null {
  if (flags.length > REGEX_TESTER_LIMITS.maxFlagsLength) {
    return {
      code: "invalid-flags",
      field: "flags",
      actual: flags.length,
      limit: REGEX_TESTER_LIMITS.maxFlagsLength,
      message: "标志组合超过长度上限。",
    };
  }

  const seen = new Set<string>();
  for (let offset = 0; offset < flags.length; offset += 1) {
    const flag = flags[offset] ?? "";
    if (!supportedFlags.has(flag) || seen.has(flag)) {
      return {
        code: "invalid-flags",
        field: "flags",
        offset,
        message: "标志包含不支持或重复的字符。",
      };
    }
    seen.add(flag);
  }

  if (seen.has("u") && seen.has("v")) {
    return {
      code: "invalid-flags",
      field: "flags",
      message: "Unicode 的 u 与 v 标志不能同时使用。",
    };
  }
  return null;
}

function advanceStringIndex(value: string, index: number) {
  if (index + 1 >= value.length) return index + 1;
  const first = value.charCodeAt(index);
  if (first < 0xd800 || first > 0xdbff) return index + 1;
  const second = value.charCodeAt(index + 1);
  return second >= 0xdc00 && second <= 0xdfff ? index + 2 : index + 1;
}

function matchResult(
  match: RegExpExecArray,
  ordinal: number,
  maxCaptures: number,
  maxOutputBytes: number,
): RegexMatchResult | RegexTestFailure {
  const captureCount = Math.max(0, match.length - 1);
  if (captureCount > maxCaptures) {
    return failure({
      code: "too-many-captures",
      field: "pattern",
      actual: captureCount,
      limit: maxCaptures,
      message: "捕获组数量超过单次匹配上限。",
    });
  }

  const text = match[0] ?? "";
  const namedEntries = Object.entries(match.groups ?? {}).sort(
    ([left], [right]) => (left < right ? -1 : left > right ? 1 : 0),
  );
  let contentBytes = getRegexTextByteLength(text);
  for (const value of match.slice(1)) {
    if (value !== undefined) contentBytes += getRegexTextByteLength(value);
    if (contentBytes > maxOutputBytes) break;
  }
  for (const [name, value] of namedEntries) {
    contentBytes += getRegexTextByteLength(name);
    if (value !== undefined) contentBytes += getRegexTextByteLength(value);
    if (contentBytes > maxOutputBytes) break;
  }
  if (contentBytes > maxOutputBytes) {
    return failure({
      code: "output-too-large",
      actual: contentBytes,
      limit: maxOutputBytes,
      message: "匹配结果超过输出上限，请缩小测试文本或捕获范围。",
    });
  }

  const namedCaptures = namedEntries.map(([name, value]) => ({
    name,
    value: value ?? null,
  }));

  return {
    ordinal,
    index: match.index,
    end: match.index + text.length,
    text,
    captures: match.slice(1).map((value) => value ?? null),
    namedCaptures,
  };
}

function serializedByteLength(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).byteLength;
}

function finalizeSuccess(
  source: Omit<RegexTestSuccess, "outputBytes">,
  maxOutputBytes: number,
): RegexTestResult {
  let outputBytes = 0;
  let result: RegexTestSuccess = { ...source, outputBytes };

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const measured = serializedByteLength(result);
    if (measured > maxOutputBytes) {
      return failure({
        code: "output-too-large",
        actual: measured,
        limit: maxOutputBytes,
        message: "匹配结果超过输出上限，请缩小测试文本或捕获范围。",
      });
    }
    if (measured === outputBytes) return result;
    outputBytes = measured;
    result = { ...source, outputBytes };
  }

  return result;
}

/**
 * Runs JavaScript RegExp synchronously under fixed data budgets.
 *
 * Catastrophic backtracking cannot be interrupted inside `RegExp#exec`, so
 * callers handling untrusted patterns must run this function in a disposable
 * Worker and enforce a wall-clock deadline by terminating that Worker.
 */
export function testRegularExpression(
  input: RegexTestInput,
  overrides: RegexTestLimitOverrides = {},
): RegexTestResult {
  if (
    typeof input?.pattern !== "string" ||
    typeof input?.flags !== "string" ||
    typeof input?.subject !== "string"
  ) {
    return failure({
      code: "invalid-input",
      message: "正则测试输入结构无效。",
    });
  }

  const limits = normalizedLimits(overrides);
  const patternBytes = getRegexTextByteLength(input.pattern);
  if (patternBytes > limits.maxPatternBytes) {
    return failure({
      code: "pattern-too-large",
      field: "pattern",
      actual: patternBytes,
      limit: limits.maxPatternBytes,
      message: "正则表达式超过 8 KiB 上限。",
    });
  }
  const subjectBytes = getRegexTextByteLength(input.subject);
  if (subjectBytes > limits.maxSubjectBytes) {
    return failure({
      code: "subject-too-large",
      field: "subject",
      actual: subjectBytes,
      limit: limits.maxSubjectBytes,
      message: "测试文本超过 256 KiB 上限。",
    });
  }

  const flagError = validateFlags(input.flags);
  if (flagError) return failure(flagError);

  try {
    // Flag support is checked separately so native error strings containing
    // user-controlled pattern text never influence error classification.
    new RegExp("", input.flags);
  } catch {
    return failure({
      code: "unsupported-flags",
      field: "flags",
      message: "当前浏览器不支持所选正则标志。",
    });
  }

  let expression: RegExp;
  try {
    expression = new RegExp(input.pattern, input.flags);
  } catch {
    return failure({
      code: "invalid-pattern",
      field: "pattern",
      message: "正则表达式语法无效，请检查括号、字符类与转义。",
    });
  }

  const matches: RegexMatchResult[] = [];
  let serializedMatchBytes = 0;
  let truncated = false;
  const repeats = expression.global || expression.sticky;
  while (true) {
    const rawMatch = expression.exec(input.subject);
    if (rawMatch === null) break;
    if (matches.length >= limits.maxMatches) {
      truncated = true;
      break;
    }

    const next = matchResult(
      rawMatch,
      matches.length + 1,
      limits.maxCapturesPerMatch,
      limits.maxOutputBytes,
    );
    if ("ok" in next && next.ok === false) return next;
    const nextMatch = next as RegexMatchResult;
    const nextBytes =
      serializedByteLength(nextMatch) + (matches.length > 0 ? 1 : 0);
    serializedMatchBytes += nextBytes;
    if (serializedMatchBytes + 512 > limits.maxOutputBytes) {
      return failure({
        code: "output-too-large",
        actual: serializedMatchBytes + 512,
        limit: limits.maxOutputBytes,
        message: "匹配结果超过输出上限，请缩小测试文本或捕获范围。",
      });
    }
    matches.push(nextMatch);

    if (!repeats) break;
    if (rawMatch[0] === "") {
      expression.lastIndex = advanceStringIndex(
        input.subject,
        expression.lastIndex,
      );
      if (expression.lastIndex > input.subject.length) break;
    }
  }

  return finalizeSuccess(
    {
      ok: true,
      patternBytes,
      subjectBytes,
      flags: expression.flags,
      matches,
      truncated,
      matchLimit: limits.maxMatches,
    },
    limits.maxOutputBytes,
  );
}

export function parseRegexOperationInput(text: string): RegexTestInput | null {
  try {
    const value: unknown = JSON.parse(text);
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).toSorted();
    if (
      keys.length !== 3 ||
      keys[0] !== "flags" ||
      keys[1] !== "pattern" ||
      keys[2] !== "subject" ||
      typeof record.pattern !== "string" ||
      typeof record.flags !== "string" ||
      typeof record.subject !== "string"
    ) {
      return null;
    }
    return {
      pattern: record.pattern,
      flags: record.flags,
      subject: record.subject,
    };
  } catch {
    return null;
  }
}

export function serializeRegexTestSuccess(result: RegexTestSuccess): string {
  return JSON.stringify(result);
}

export const REGEX_TESTER_LIMITS = Object.freeze({
  maxPatternBytes: 8 * 1024,
  maxSubjectBytes: 256 * 1024,
  maxFlagsLength: 8,
  maxMatches: 1_000,
  maxCapturesPerMatch: 256,
  maxOutputBytes: 2 * 1024 * 1024,
});

export const SUPPORTED_REGEX_FLAGS = Object.freeze([
  "g",
  "i",
  "m",
  "s",
  "u",
  "v",
  "y",
] as const);

export type SupportedRegexFlag = (typeof SUPPORTED_REGEX_FLAGS)[number];

export function getRegexTextByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export interface RegexTestInput {
  readonly pattern: string;
  readonly flags: string;
  readonly subject: string;
}

export interface RegexNamedCapture {
  readonly name: string;
  readonly value: string | null;
}

export interface RegexMatchResult {
  readonly ordinal: number;
  readonly index: number;
  readonly end: number;
  readonly text: string;
  readonly captures: readonly (string | null)[];
  readonly namedCaptures: readonly RegexNamedCapture[];
}

export type RegexTestErrorCode =
  | "invalid-input"
  | "pattern-too-large"
  | "subject-too-large"
  | "invalid-flags"
  | "unsupported-flags"
  | "invalid-pattern"
  | "too-many-captures"
  | "output-too-large";

export interface RegexTestError {
  readonly code: RegexTestErrorCode;
  readonly message: string;
  readonly field?: "pattern" | "flags" | "subject";
  readonly offset?: number;
  readonly actual?: number;
  readonly limit?: number;
}

export interface RegexTestSuccess {
  readonly ok: true;
  readonly patternBytes: number;
  readonly subjectBytes: number;
  readonly flags: string;
  readonly matches: readonly RegexMatchResult[];
  readonly truncated: boolean;
  readonly matchLimit: number;
  readonly outputBytes: number;
}

export interface RegexTestFailure {
  readonly ok: false;
  readonly error: RegexTestError;
}

export type RegexTestResult = RegexTestSuccess | RegexTestFailure;

export const REGEX_WORKER_PROTOCOL_VERSION = 1 as const;

export interface RegexWorkerExecuteMessage {
  readonly type: "REGEX_TEST_EXECUTE";
  readonly protocol: typeof REGEX_WORKER_PROTOCOL_VERSION;
  readonly taskId: string;
  readonly input: RegexTestInput;
}

export interface RegexWorkerResultMessage {
  readonly type: "REGEX_TEST_RESULT";
  readonly protocol: typeof REGEX_WORKER_PROTOCOL_VERSION;
  readonly taskId: string;
  readonly result: RegexTestResult;
}

const taskIdPattern = /^regex-[A-Za-z0-9_-]{1,96}$/u;
const errorCodes = new Set<RegexTestErrorCode>([
  "invalid-input",
  "pattern-too-large",
  "subject-too-large",
  "invalid-flags",
  "unsupported-flags",
  "invalid-pattern",
  "too-many-captures",
  "output-too-large",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value).toSorted();
  const sortedExpected = [...expected].toSorted();
  return (
    keys.length === sortedExpected.length &&
    keys.every((key, index) => key === sortedExpected[index])
  );
}

function isSafeCount(value: unknown, maximum = Number.MAX_SAFE_INTEGER) {
  return (
    Number.isSafeInteger(value) &&
    Number(value) >= 0 &&
    Number(value) <= maximum
  );
}

function isRegexTestError(value: unknown): value is RegexTestError {
  if (!isRecord(value)) return false;
  const allowed = new Set([
    "code",
    "message",
    "field",
    "offset",
    "actual",
    "limit",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return false;
  if (
    typeof value.code !== "string" ||
    !errorCodes.has(value.code as RegexTestErrorCode) ||
    typeof value.message !== "string" ||
    value.message.length === 0 ||
    value.message.length > 256
  ) {
    return false;
  }
  if (
    value.field !== undefined &&
    value.field !== "pattern" &&
    value.field !== "flags" &&
    value.field !== "subject"
  ) {
    return false;
  }
  return [value.offset, value.actual, value.limit].every(
    (item) => item === undefined || isSafeCount(item),
  );
}

function isRegexMatch(value: unknown): value is RegexMatchResult {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "ordinal",
      "index",
      "end",
      "text",
      "captures",
      "namedCaptures",
    ]) ||
    !isSafeCount(value.ordinal, REGEX_TESTER_LIMITS.maxMatches) ||
    Number(value.ordinal) < 1 ||
    !isSafeCount(value.index) ||
    !isSafeCount(value.end) ||
    Number(value.end) < Number(value.index) ||
    typeof value.text !== "string" ||
    !Array.isArray(value.captures) ||
    value.captures.length > REGEX_TESTER_LIMITS.maxCapturesPerMatch ||
    !value.captures.every(
      (capture) => capture === null || typeof capture === "string",
    ) ||
    !Array.isArray(value.namedCaptures) ||
    value.namedCaptures.length > REGEX_TESTER_LIMITS.maxCapturesPerMatch
  ) {
    return false;
  }

  return value.namedCaptures.every(
    (capture) =>
      isRecord(capture) &&
      hasExactKeys(capture, ["name", "value"]) &&
      typeof capture.name === "string" &&
      capture.name.length > 0 &&
      capture.name.length <= REGEX_TESTER_LIMITS.maxPatternBytes &&
      (capture.value === null || typeof capture.value === "string"),
  );
}

export function isRegexWorkerResultMessage(
  value: unknown,
  expectedTaskId: string,
): value is RegexWorkerResultMessage {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["type", "protocol", "taskId", "result"]) ||
    value.type !== "REGEX_TEST_RESULT" ||
    value.protocol !== REGEX_WORKER_PROTOCOL_VERSION ||
    value.taskId !== expectedTaskId ||
    !taskIdPattern.test(expectedTaskId) ||
    !isRecord(value.result)
  ) {
    return false;
  }

  if (value.result.ok === false) {
    return (
      hasExactKeys(value.result, ["ok", "error"]) &&
      isRegexTestError(value.result.error)
    );
  }

  if (
    value.result.ok !== true ||
    !hasExactKeys(value.result, [
      "ok",
      "patternBytes",
      "subjectBytes",
      "flags",
      "matches",
      "truncated",
      "matchLimit",
      "outputBytes",
    ]) ||
    !isSafeCount(
      value.result.patternBytes,
      REGEX_TESTER_LIMITS.maxPatternBytes,
    ) ||
    !isSafeCount(
      value.result.subjectBytes,
      REGEX_TESTER_LIMITS.maxSubjectBytes,
    ) ||
    typeof value.result.flags !== "string" ||
    value.result.flags.length > REGEX_TESTER_LIMITS.maxFlagsLength ||
    !Array.isArray(value.result.matches) ||
    value.result.matches.length > REGEX_TESTER_LIMITS.maxMatches ||
    !value.result.matches.every(isRegexMatch) ||
    typeof value.result.truncated !== "boolean" ||
    value.result.matchLimit !== REGEX_TESTER_LIMITS.maxMatches ||
    !isSafeCount(value.result.outputBytes, REGEX_TESTER_LIMITS.maxOutputBytes)
  ) {
    return false;
  }

  try {
    return (
      new TextEncoder().encode(JSON.stringify(value.result)).byteLength <=
      REGEX_TESTER_LIMITS.maxOutputBytes
    );
  } catch {
    return false;
  }
}

export function isRegexWorkerExecuteMessage(
  value: unknown,
): value is RegexWorkerExecuteMessage {
  return Boolean(
    isRecord(value) &&
    hasExactKeys(value, ["type", "protocol", "taskId", "input"]) &&
    value.type === "REGEX_TEST_EXECUTE" &&
    value.protocol === REGEX_WORKER_PROTOCOL_VERSION &&
    typeof value.taskId === "string" &&
    taskIdPattern.test(value.taskId) &&
    isRecord(value.input) &&
    hasExactKeys(value.input, ["pattern", "flags", "subject"]) &&
    typeof value.input.pattern === "string" &&
    typeof value.input.flags === "string" &&
    typeof value.input.subject === "string",
  );
}

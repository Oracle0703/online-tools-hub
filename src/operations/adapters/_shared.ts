import {
  type JsonObject,
  type JsonPrimitive,
  type JsonValue,
  type OperationDefinition,
  type OperationInput,
  type OperationInputKind,
} from "../contract";
import { OperationError } from "../errors";

export type OperationContext = Parameters<OperationDefinition["execute"]>[2];

export function assertAllowedOptions(
  operationId: string,
  options: JsonObject,
  allowedKeys: readonly string[],
): void {
  const allowed = new Set(allowedKeys);
  const unknownKeys = Object.keys(options).filter((key) => !allowed.has(key));

  if (unknownKeys.length > 0) {
    throw invalidOptions(
      operationId,
      `包含 ${unknownKeys.length} 个不受支持的选项。`,
      { unknownKeyCount: unknownKeys.length },
    );
  }
}

export function optionalEnum<const T extends readonly JsonPrimitive[]>(
  operationId: string,
  options: JsonObject,
  key: string,
  allowed: T,
  fallback: T[number],
): T[number] {
  const value = options[key];
  if (value === undefined) return fallback;

  if (!allowed.includes(value as JsonPrimitive)) {
    throw invalidOptions(
      operationId,
      `${key} 必须是 ${allowed.map(String).join("、")} 之一。`,
      { key, allowed: [...allowed] },
    );
  }

  return value as T[number];
}

export function optionalBoolean(
  operationId: string,
  options: JsonObject,
  key: string,
  fallback: boolean,
): boolean {
  const value = options[key];
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") {
    throw invalidOptions(operationId, `${key} 必须是布尔值。`, { key });
  }
  return value;
}

export function optionalInteger(
  operationId: string,
  options: JsonObject,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = options[key];
  if (value === undefined) return fallback;

  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw invalidOptions(
      operationId,
      `${key} 必须是 ${minimum}–${maximum} 之间的安全整数。`,
      { key, minimum, maximum },
    );
  }

  return value;
}

export function optionalFiniteNumber(
  operationId: string,
  options: JsonObject,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = options[key];
  if (value === undefined) return fallback;

  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw invalidOptions(
      operationId,
      `${key} 必须是 ${minimum}–${maximum} 之间的有限数字。`,
      { key, minimum, maximum },
    );
  }

  return value;
}

export function optionalString(
  operationId: string,
  options: JsonObject,
  key: string,
  fallback: string | undefined,
  maximumLength = 128,
): string | undefined {
  const value = options[key];
  if (value === undefined) return fallback;

  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumLength
  ) {
    throw invalidOptions(
      operationId,
      `${key} 必须是 1–${maximumLength} 个字符的字符串。`,
      { key, maximumLength },
    );
  }

  return value;
}

export function expectInputKind<K extends OperationInputKind>(
  operationId: string,
  input: OperationInput,
  kind: K,
): Extract<OperationInput, { kind: K }> {
  if (input.kind !== kind) {
    throw new OperationError(
      "type-mismatch",
      `${operationId} 需要 ${kind} 输入，实际收到 ${input.kind}。`,
      {
        operationId,
        details: { expectedKind: kind, actualKind: input.kind },
      },
    );
  }

  return input as Extract<OperationInput, { kind: K }>;
}

export function checkpoint(context: OperationContext): void {
  context.checkCancelled();
}

export function failFromCore(operationId: string, error: unknown): never {
  const record = isRecord(error) ? error : undefined;
  const sourceCode = readSourceCode(record);
  const details: Record<string, JsonValue> = sourceCode ? { sourceCode } : {};

  for (const key of [
    "offset",
    "line",
    "column",
    "side",
    "segment",
    "actual",
    "limit",
  ] as const) {
    const value = record?.[key];
    if (isJsonScalar(value)) details[key] = value;
  }

  throw new OperationError(
    sourceCode === "crypto-unavailable"
      ? "unsupported-environment"
      : "execution-failed",
    sourceCode === "crypto-unavailable"
      ? "当前浏览器缺少此操作所需的密码学能力。"
      : sourceCode
        ? "输入未通过本地处理规则，请根据错误代码和位置修正。"
        : "本地处理失败，请重试或调整输入。",
    {
      operationId,
      details,
    },
  );
}

export async function mapThrownError<T>(
  operationId: string,
  action: () => T | Promise<T>,
): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof OperationError) throw error;

    const record = isRecord(error) ? error : undefined;
    const sourceCode = readSourceCode(record);

    throw new OperationError(
      sourceCode === "crypto-unavailable"
        ? "unsupported-environment"
        : "execution-failed",
      sourceCode === "crypto-unavailable"
        ? "当前浏览器缺少此操作所需的密码学能力。"
        : "本地处理失败，请重试。",
      {
        operationId,
        details: sourceCode ? { sourceCode } : {},
        cause: error,
      },
    );
  }
}

export function invalidOptions(
  operationId: string,
  message: string,
  details: JsonObject = {},
): OperationError {
  return new OperationError("invalid-options", message, {
    operationId,
    details,
  });
}

function readSourceCode(record: Record<string, unknown> | undefined) {
  const code = record?.code ?? record?.kind;
  return typeof code === "string" &&
    code.length <= 64 &&
    /^[A-Za-z0-9]+(?:[_-][A-Za-z0-9]+)*$/u.test(code)
    ? code
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isJsonScalar(value: unknown): value is Exclude<JsonValue, object> {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

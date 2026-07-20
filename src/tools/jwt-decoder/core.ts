import { decodeBase64 } from "../base64-codec";

export const MAX_JWT_BYTES = 256 * 1024;
export const MAX_JWT_JSON_DEPTH = 64;
export const MAX_JWT_JSON_NODES = 10_000;
export const MAX_JWT_JSON_NUMBER_CHARS = 128;

export type JwtSegmentName = "header" | "payload" | "signature";
export type JwtTimeClaimName = "exp" | "nbf" | "iat";
export type JwtTimeState =
  | "expired"
  | "valid"
  | "pending"
  | "active"
  | "future"
  | "past"
  | "invalid-type"
  | "invalid-date";

export type JwtObject = Record<string, unknown>;

export type JwtTimeClaim = {
  claim: JwtTimeClaimName;
  seconds: number | null;
  iso: string | null;
  state: JwtTimeState;
  message: string;
};

export type DecodedJwt = {
  token: string;
  header: JwtObject;
  payload: JwtObject;
  signature: string;
  signingInput: string;
  algorithm: string | null;
  tokenType: string | null;
  isUnsigned: boolean;
  timeClaims: JwtTimeClaim[];
};

export type JwtDecodeErrorCode =
  | "EMPTY"
  | "TOO_LARGE"
  | "INVALID_COMPACT_FORMAT"
  | "INVALID_SEGMENT"
  | "INVALID_JSON"
  | "INVALID_JSON_OBJECT"
  | "UNSAFE_JSON_NUMBER"
  | "JSON_STRUCTURE_LIMIT";

export type JwtDecodeError = {
  code: JwtDecodeErrorCode;
  message: string;
  segment?: JwtSegmentName;
};

export type JwtDecodeResult =
  { ok: true; value: DecodedJwt } | { ok: false; error: JwtDecodeError };

function failure(
  code: JwtDecodeErrorCode,
  message: string,
  segment?: JwtSegmentName,
): JwtDecodeResult {
  return {
    ok: false,
    error:
      segment === undefined ? { code, message } : { code, message, segment },
  };
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isJwtObject(value: unknown): value is JwtObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function signatureError(value: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    return "Signature 不是有效的无填充 Base64URL 文本。";
  }

  const remainder = value.length % 4;
  if (remainder === 1) {
    return "Signature 的 Base64URL 长度无效。";
  }

  if (remainder === 2 || remainder === 3) {
    const alphabet =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const lastValue = alphabet.indexOf(value.at(-1) ?? "");
    const unusedBitMask = remainder === 2 ? 0x0f : 0x03;
    if ((lastValue & unusedBitMask) !== 0) {
      return "Signature 含有非零填充位，不是规范的 Base64URL。";
    }
  }

  return null;
}

function decodeObjectSegment(
  encoded: string,
  segment: "header" | "payload",
): { ok: true; value: JwtObject } | { ok: false; error: JwtDecodeError } {
  if (!encoded) {
    return {
      ok: false,
      error: {
        code: "INVALID_SEGMENT",
        segment,
        message: `${segment === "header" ? "Header" : "Payload"} 段不能为空。`,
      },
    };
  }

  if (!/^[A-Za-z0-9_-]+$/u.test(encoded)) {
    return {
      ok: false,
      error: {
        code: "INVALID_SEGMENT",
        segment,
        message: `${segment === "header" ? "Header" : "Payload"} 必须是无填充 Base64URL，只能包含字母、数字、- 和 _，不能包含 =。`,
      },
    };
  }

  const decoded = decodeBase64(encoded, "url");
  if (!decoded.ok) {
    return {
      ok: false,
      error: {
        code: "INVALID_SEGMENT",
        segment,
        message: `${segment === "header" ? "Header" : "Payload"} 不是规范的 Base64URL：${decoded.error.message}`,
      },
    };
  }

  const sourceSafetyError = inspectJsonSource(decoded.value, segment);
  if (sourceSafetyError) {
    return { ok: false, error: sourceSafetyError };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded.value) as unknown;
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "INVALID_JSON",
        segment,
        message: `${segment === "header" ? "Header" : "Payload"} 不是有效 JSON：${error instanceof Error ? error.message : "无法解析 JSON"}`,
      },
    };
  }

  if (!isJwtObject(parsed)) {
    return {
      ok: false,
      error: {
        code: "INVALID_JSON_OBJECT",
        segment,
        message: `${segment === "header" ? "Header" : "Payload"} 必须是 JSON 对象。`,
      },
    };
  }

  const structureError = inspectJsonStructure(parsed, segment);
  if (structureError) {
    return { ok: false, error: structureError };
  }

  return { ok: true, value: parsed };
}

function inspectJsonSource(
  source: string,
  segment: "header" | "payload",
): JwtDecodeError | null {
  let depth = 0;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;

    if (character === '"') {
      index = skipJsonString(source, index);
      continue;
    }

    if (character === "{" || character === "[") {
      depth += 1;
      if (depth > MAX_JWT_JSON_DEPTH) {
        return {
          code: "JSON_STRUCTURE_LIMIT",
          segment,
          message: `${segment === "header" ? "Header" : "Payload"} 嵌套超过 ${MAX_JWT_JSON_DEPTH} 层安全上限。`,
        };
      }
      continue;
    }

    if (character === "}" || character === "]") {
      depth = Math.max(0, depth - 1);
      continue;
    }

    if (character === "-" || isDigit(character)) {
      const end = scanJsonNumber(source, index);
      if (end === null) continue;

      const literal = source.slice(index, end);
      const numberError = validateJsonNumber(literal, segment);
      if (numberError) return numberError;
      index = end - 1;
    }
  }

  return null;
}

function skipJsonString(source: string, openingQuote: number): number {
  for (let index = openingQuote + 1; index < source.length; index += 1) {
    if (source[index] === "\\") {
      index += 1;
      continue;
    }
    if (source[index] === '"') return index;
  }
  return source.length - 1;
}

function scanJsonNumber(source: string, start: number): number | null {
  let index = start;
  if (source[index] === "-") index += 1;
  if (index >= source.length) return null;

  if (source[index] === "0") {
    index += 1;
  } else if (isNonZeroDigit(source[index])) {
    index += 1;
    while (isDigit(source[index])) index += 1;
  } else {
    return null;
  }

  if (source[index] === ".") {
    index += 1;
    if (!isDigit(source[index])) return null;
    while (isDigit(source[index])) index += 1;
  }

  if (source[index] === "e" || source[index] === "E") {
    index += 1;
    if (source[index] === "+" || source[index] === "-") index += 1;
    if (!isDigit(source[index])) return null;
    while (isDigit(source[index])) index += 1;
  }

  return index;
}

function validateJsonNumber(
  literal: string,
  segment: "header" | "payload",
): JwtDecodeError | null {
  const label = segment === "header" ? "Header" : "Payload";
  if (literal.length > MAX_JWT_JSON_NUMBER_CHARS) {
    return {
      code: "UNSAFE_JSON_NUMBER",
      segment,
      message: `${label} 中的数字字面量超过 ${MAX_JWT_JSON_NUMBER_CHARS} 个字符，已拒绝以避免资源消耗和精度丢失。`,
    };
  }

  const value = Number(literal);
  if (!Number.isFinite(value)) {
    return unsafeNumberFailure(
      segment,
      `${label} 中的数字 ${literal} 会在 JavaScript 中溢出为非有限值。`,
    );
  }

  const parts = decimalParts(literal);
  if (!parts) return null;
  if (parts.coefficient === 0n) return null;

  if (value === 0) {
    return unsafeNumberFailure(
      segment,
      `${label} 中的数字 ${literal} 会在 JavaScript 中下溢为 0。`,
    );
  }

  if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
    return unsafeNumberFailure(
      segment,
      `${label} 中的整数 ${literal} 超出 JavaScript 安全整数范围。`,
    );
  }

  if (!decimalValueRoundTrips(parts, value)) {
    return unsafeNumberFailure(
      segment,
      `${label} 中的数字 ${literal} 解析后会被改写为 ${String(value)}。`,
    );
  }

  return null;
}

type DecimalParts = {
  coefficient: bigint;
  decimalExponent: number;
};

function decimalParts(literal: string): DecimalParts | null {
  const match =
    /^(?<sign>-?)(?<integer>0|[1-9]\d*)(?:\.(?<fraction>\d+))?(?:[eE](?<exponent>[+-]?\d+))?$/u.exec(
      literal,
    );
  if (!match?.groups) return null;

  const fraction = match.groups.fraction ?? "";
  const coefficientText = `${match.groups.integer}${fraction}`;
  const sign = match.groups.sign === "-" ? -1n : 1n;
  const coefficient = sign * BigInt(coefficientText);
  const exponent = Number(match.groups.exponent ?? "0");

  return {
    coefficient,
    decimalExponent: exponent - fraction.length,
  };
}

function decimalValueRoundTrips(decimal: DecimalParts, value: number): boolean {
  const rendered = decimalParts(String(value));
  if (!rendered) return false;

  const normalizedSource = normalizeDecimalParts(decimal);
  const normalizedRendered = normalizeDecimalParts(rendered);
  return (
    normalizedSource.coefficient === normalizedRendered.coefficient &&
    normalizedSource.decimalExponent === normalizedRendered.decimalExponent
  );
}

function normalizeDecimalParts(decimal: DecimalParts): DecimalParts {
  if (decimal.coefficient === 0n) {
    return { coefficient: 0n, decimalExponent: 0 };
  }

  let coefficient = decimal.coefficient;
  let decimalExponent = decimal.decimalExponent;
  while (coefficient % 10n === 0n) {
    coefficient /= 10n;
    decimalExponent += 1;
  }

  return { coefficient, decimalExponent };
}

function inspectJsonStructure(
  root: JwtObject,
  segment: "header" | "payload",
): JwtDecodeError | null {
  const stack: unknown[] = [root];
  let nodes = 0;

  while (stack.length) {
    const value = stack.pop();
    nodes += 1;
    if (nodes > MAX_JWT_JSON_NODES) {
      return {
        code: "JSON_STRUCTURE_LIMIT",
        segment,
        message: `${segment === "header" ? "Header" : "Payload"} 结构超过 ${MAX_JWT_JSON_NODES.toLocaleString("en-US")} 个节点安全上限。`,
      };
    }

    if (!value || typeof value !== "object") continue;
    if (Array.isArray(value)) {
      for (let index = value.length - 1; index >= 0; index -= 1) {
        stack.push(value[index]);
      }
      continue;
    }

    for (const child of Object.values(value)) stack.push(child);
  }

  return null;
}

function unsafeNumberFailure(
  segment: "header" | "payload",
  detail: string,
): JwtDecodeError {
  return {
    code: "UNSAFE_JSON_NUMBER",
    segment,
    message: `${detail} 为避免静默改值，只接受安全整数以及解析后十进制值可稳定往返的有限小数或指数；需要保留原值时请改用 JSON 字符串。`,
  };
}

function isDigit(value: string | undefined): boolean {
  return value !== undefined && value >= "0" && value <= "9";
}

function isNonZeroDigit(value: string | undefined): boolean {
  return value !== undefined && value >= "1" && value <= "9";
}

function timeClaim(
  claim: JwtTimeClaimName,
  value: unknown,
  nowMilliseconds: number,
): JwtTimeClaim {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return {
      claim,
      seconds: null,
      iso: null,
      state: "invalid-type",
      message: `${claim} 必须是有限数值类型的 NumericDate（Unix 秒）。`,
    };
  }

  const milliseconds = value * 1000;
  const date = new Date(milliseconds);
  if (!Number.isFinite(date.getTime())) {
    return {
      claim,
      seconds: value,
      iso: null,
      state: "invalid-date",
      message: "数值超出浏览器可表示的日期范围。",
    };
  }

  const iso = date.toISOString();
  if (claim === "exp") {
    const expired = nowMilliseconds >= milliseconds;
    return {
      claim,
      seconds: value,
      iso,
      state: expired ? "expired" : "valid",
      message: expired ? "令牌已到期。" : "按 exp 字段，令牌尚未到期。",
    };
  }

  if (claim === "nbf") {
    const pending = nowMilliseconds < milliseconds;
    return {
      claim,
      seconds: value,
      iso,
      state: pending ? "pending" : "active",
      message: pending ? "尚未到生效时间。" : "已到 nbf 指定的生效时间。",
    };
  }

  const future = milliseconds > nowMilliseconds;
  return {
    claim,
    seconds: value,
    iso,
    state: future ? "future" : "past",
    message: future
      ? "iat 位于当前时间之后，请核对时钟。"
      : "签发时间不晚于当前时间。",
  };
}

export function decodeJwt(
  input: string,
  nowMilliseconds = Date.now(),
): JwtDecodeResult {
  const inputSize = byteLength(input);
  if (inputSize > MAX_JWT_BYTES) {
    return failure(
      "TOO_LARGE",
      `JWT 为 ${inputSize} B，超过 ${MAX_JWT_BYTES / 1024} KiB 上限。`,
    );
  }

  const token = input.trim();
  if (!token) return failure("EMPTY", "请先输入 JWT。");

  if (/\s/u.test(token)) {
    return failure(
      "INVALID_COMPACT_FORMAT",
      "JWT 紧凑格式不能包含空格或换行。",
    );
  }

  const segments = token.split(".");
  if (segments.length !== 3) {
    return failure(
      "INVALID_COMPACT_FORMAT",
      "JWT 紧凑格式必须正好包含 Header、Payload 和 Signature 三段。",
    );
  }

  const [headerSegment = "", payloadSegment = "", signature = ""] = segments;
  const invalidSignature = signature ? signatureError(signature) : null;
  if (invalidSignature) {
    return failure("INVALID_SEGMENT", invalidSignature, "signature");
  }

  const header = decodeObjectSegment(headerSegment, "header");
  if (!header.ok) return { ok: false, error: header.error };
  const payload = decodeObjectSegment(payloadSegment, "payload");
  if (!payload.ok) return { ok: false, error: payload.error };

  const timeClaims = (["exp", "nbf", "iat"] as const).flatMap((claim) =>
    Object.prototype.hasOwnProperty.call(payload.value, claim)
      ? [timeClaim(claim, payload.value[claim], nowMilliseconds)]
      : [],
  );
  const algorithm =
    typeof header.value.alg === "string" ? header.value.alg : null;
  const tokenType =
    typeof header.value.typ === "string" ? header.value.typ : null;

  return {
    ok: true,
    value: {
      token,
      header: header.value,
      payload: payload.value,
      signature,
      signingInput: `${headerSegment}.${payloadSegment}`,
      algorithm,
      tokenType,
      isUnsigned: signature.length === 0 || algorithm?.toLowerCase() === "none",
      timeClaims,
    },
  };
}

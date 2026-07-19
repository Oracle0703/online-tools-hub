export const MIN_UUID_COUNT = 1;
export const MAX_UUID_COUNT = 1_000;

export interface UuidCryptoSource {
  randomUUID?: () => string;
  getRandomValues?: (array: Uint8Array) => Uint8Array;
}

export type UuidGenerationErrorCode =
  | "invalid-count"
  | "crypto-unavailable"
  | "generation-failed"
  | "invalid-result"
  | "duplicate-exhausted";

export interface UuidGenerationError {
  code: UuidGenerationErrorCode;
  message: string;
}

export type UuidGenerationResult =
  { ok: true; value: string[] } | { ok: false; error: UuidGenerationError };

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Validates both the UUID shape and the RFC 4122 version/variant bits. */
export function isUuidV4(value: string): boolean {
  return UUID_V4_PATTERN.test(value);
}

/**
 * Generates unique UUID v4 values from a browser cryptographic source.
 * Math.random is deliberately never used as a fallback.
 */
export function generateUuidV4(
  count = 1,
  source: UuidCryptoSource | undefined = getBrowserCrypto(),
): UuidGenerationResult {
  if (
    !Number.isInteger(count) ||
    count < MIN_UUID_COUNT ||
    count > MAX_UUID_COUNT
  ) {
    return failure(
      "invalid-count",
      `生成数量必须是 ${MIN_UUID_COUNT}–${MAX_UUID_COUNT} 之间的整数。`,
    );
  }

  if (!source || (!source.randomUUID && !source.getRandomValues)) {
    return failure(
      "crypto-unavailable",
      "当前浏览器没有可用的密码学安全随机数 API。",
    );
  }

  const values = new Set<string>();
  const maximumAttempts = Math.max(100, count * 12);
  let attempts = 0;

  while (values.size < count && attempts < maximumAttempts) {
    attempts += 1;
    const generated = createUuid(source);
    if (!generated.ok) return generated;
    values.add(generated.value);
  }

  if (values.size !== count) {
    return failure(
      "duplicate-exhausted",
      "安全随机源持续返回重复值，已停止生成，请重试。",
    );
  }

  return { ok: true, value: [...values] };
}

/** Converts exactly 16 bytes into an RFC 4122 UUID v4 string. */
export function uuidV4FromBytes(bytes: Uint8Array): string {
  if (bytes.length !== 16) {
    throw new RangeError("UUID v4 requires exactly 16 bytes.");
  }

  const normalized = Uint8Array.from(bytes);
  normalized[6] = (normalized[6]! & 0x0f) | 0x40;
  normalized[8] = (normalized[8]! & 0x3f) | 0x80;

  const hex = [...normalized].map((byte) => byte.toString(16).padStart(2, "0"));
  return [
    hex.slice(0, 4).join(""),
    hex.slice(4, 6).join(""),
    hex.slice(6, 8).join(""),
    hex.slice(8, 10).join(""),
    hex.slice(10, 16).join(""),
  ].join("-");
}

function getBrowserCrypto(): UuidCryptoSource | undefined {
  if (typeof globalThis.crypto === "undefined") return undefined;
  return globalThis.crypto as UuidCryptoSource;
}

function createUuid(
  source: UuidCryptoSource,
): { ok: true; value: string } | { ok: false; error: UuidGenerationError } {
  let randomUuidFailure: UuidGenerationError | undefined;

  if (source.randomUUID) {
    try {
      const candidate = source.randomUUID();
      if (isUuidV4(candidate)) {
        return { ok: true, value: candidate.toLowerCase() };
      }
      randomUuidFailure = {
        code: "invalid-result",
        message: "安全随机源返回了无效的 UUID v4。",
      };
    } catch {
      randomUuidFailure = {
        code: "generation-failed",
        message: "密码学安全随机源调用失败，请重试。",
      };
    }
  }

  if (source.getRandomValues) {
    try {
      const bytes = new Uint8Array(16);
      const filled = source.getRandomValues(bytes);
      if (!(filled instanceof Uint8Array) || filled.length !== 16) {
        return failure("invalid-result", "安全随机源返回了无效的随机字节。");
      }
      return { ok: true, value: uuidV4FromBytes(filled) };
    } catch {
      return failure("generation-failed", "密码学安全随机源调用失败，请重试。");
    }
  }

  return randomUuidFailure
    ? { ok: false, error: randomUuidFailure }
    : failure(
        "crypto-unavailable",
        "当前浏览器没有可用的密码学安全随机数 API。",
      );
}

function failure(
  code: UuidGenerationErrorCode,
  message: string,
): { ok: false; error: UuidGenerationError } {
  return { ok: false, error: { code, message } };
}

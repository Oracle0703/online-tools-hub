export type HashAlgorithm = "SHA-256" | "SHA-512";

export const MAX_HASH_TEXT_BYTES = 2 * 1024 * 1024;
export const MAX_HASH_FILE_BYTES = 20 * 1024 * 1024;

export interface HashDigestSource {
  digest(algorithm: HashAlgorithm, data: ArrayBuffer): Promise<ArrayBuffer>;
}

export type HashToolErrorCode =
  "crypto-unavailable" | "input-too-large" | "digest-failed";

export class HashToolError extends Error {
  readonly code: HashToolErrorCode;

  constructor(code: HashToolErrorCode, message: string) {
    super(message);
    this.name = "HashToolError";
    this.code = code;
  }
}

export type HashComparisonErrorCode =
  "invalid-actual" | "invalid-length" | "invalid-character";

export type HashComparisonResult =
  | { ok: true; matches: boolean; normalizedExpected: string }
  | {
      ok: false;
      error: { code: HashComparisonErrorCode; message: string };
    };

/** Returns the UTF-8 byte length that Web Crypto will hash. */
export function getUtf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/** Converts digest bytes to a lowercase, zero-padded hexadecimal string. */
export function bytesToHex(value: ArrayBuffer | ArrayBufferView): string {
  const bytes =
    value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);

  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

/**
 * Hashes bytes with the browser Web Crypto API.
 *
 * `SubtleCrypto.digest()` is a one-shot operation: callers must already have
 * the complete input in memory. It is deliberately not presented as a
 * streaming API.
 */
export async function hashBytes(
  value: ArrayBuffer | ArrayBufferView,
  algorithm: HashAlgorithm,
  source: HashDigestSource | null = getBrowserDigestSource(),
): Promise<string> {
  if (!source) {
    throw new HashToolError(
      "crypto-unavailable",
      "当前浏览器没有可用的 Web Crypto 摘要 API。",
    );
  }

  const data = copyToArrayBuffer(value);

  try {
    return bytesToHex(await source.digest(algorithm, data));
  } catch {
    throw new HashToolError(
      "digest-failed",
      "浏览器未能完成摘要计算，请重试。",
    );
  }
}

/** Hashes UTF-8 text after enforcing the browser-memory safety limit. */
export async function hashText(
  value: string,
  algorithm: HashAlgorithm,
  source: HashDigestSource | null = getBrowserDigestSource(),
  maximumBytes = MAX_HASH_TEXT_BYTES,
): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  assertWithinLimit(bytes.byteLength, maximumBytes, "文本");
  return hashBytes(bytes, algorithm, source);
}

/**
 * Hashes a Blob/File locally. The size is checked before `arrayBuffer()` so an
 * oversized file is never read into memory by this helper.
 */
export async function hashBlob(
  value: Blob,
  algorithm: HashAlgorithm,
  source: HashDigestSource | null = getBrowserDigestSource(),
  maximumBytes = MAX_HASH_FILE_BYTES,
): Promise<string> {
  assertWithinLimit(value.size, maximumBytes, "文件");
  if (!source) {
    throw new HashToolError(
      "crypto-unavailable",
      "当前浏览器没有可用的 Web Crypto 摘要 API。",
    );
  }
  return hashBytes(await value.arrayBuffer(), algorithm, source);
}

/**
 * Compares fixed-length hex digests without returning early on a mismatch.
 * This is constant-time-style defensive code; JavaScript engines and browser
 * scheduling cannot provide a strict constant-time guarantee.
 */
export function compareHashHex(
  actual: string,
  expected: string,
  algorithm: HashAlgorithm,
): HashComparisonResult {
  const length = algorithm === "SHA-256" ? 64 : 128;
  const normalizedActual = actual.trim().toLowerCase();
  const normalizedExpected = expected.trim().toLowerCase();

  if (
    normalizedActual.length !== length ||
    !/^[0-9a-f]+$/u.test(normalizedActual)
  ) {
    return comparisonFailure(
      "invalid-actual",
      "生成的摘要格式无效，请重新计算。",
    );
  }

  if (normalizedExpected.length !== length) {
    return comparisonFailure(
      "invalid-length",
      `${algorithm} 期望值必须正好包含 ${length} 个十六进制字符。`,
    );
  }

  if (!/^[0-9a-f]+$/u.test(normalizedExpected)) {
    return comparisonFailure(
      "invalid-character",
      "期望值只能包含 0–9、a–f 或 A–F。",
    );
  }

  let difference = 0;
  for (let index = 0; index < length; index += 1) {
    difference |=
      normalizedActual.charCodeAt(index) ^ normalizedExpected.charCodeAt(index);
  }

  return {
    ok: true,
    matches: difference === 0,
    normalizedExpected,
  };
}

function assertWithinLimit(
  byteLength: number,
  maximumBytes: number,
  label: string,
): void {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    throw new RangeError("maximumBytes must be a non-negative safe integer.");
  }

  if (byteLength > maximumBytes) {
    throw new HashToolError(
      "input-too-large",
      `${label}大小超过浏览器一次性摘要上限。`,
    );
  }
}

function copyToArrayBuffer(value: ArrayBuffer | ArrayBufferView): ArrayBuffer {
  if (value instanceof ArrayBuffer) return value.slice(0);

  return Uint8Array.from(
    new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
  ).buffer;
}

function getBrowserDigestSource(): HashDigestSource | null {
  if (typeof globalThis.crypto?.subtle?.digest !== "function") return null;
  return globalThis.crypto.subtle as HashDigestSource;
}

function comparisonFailure(
  code: HashComparisonErrorCode,
  message: string,
): HashComparisonResult {
  return { ok: false, error: { code, message } };
}

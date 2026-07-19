export type Base64Variant = "standard" | "url";

export type Base64DecodeErrorCode =
  | "INVALID_CHARACTER"
  | "INVALID_LENGTH"
  | "INVALID_PADDING"
  | "NON_CANONICAL_ENCODING"
  | "INVALID_UTF8";

export interface Base64DecodeError {
  code: Base64DecodeErrorCode;
  message: string;
  /** Zero-based UTF-16 offset when the error points to source text. */
  offset?: number;
}

export type Base64DecodeResult =
  { ok: true; value: string } | { ok: false; error: Base64DecodeError };

const STANDARD_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const URL_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** Encodes a JavaScript string as UTF-8, then Base64 or unpadded Base64URL. */
export function encodeBase64(
  input: string,
  variant: Base64Variant = "standard",
): string {
  const invalidSurrogate = findUnpairedSurrogate(input);
  if (invalidSurrogate !== -1) {
    throw new TypeError(
      `第 ${invalidSurrogate + 1} 个 UTF-16 代码单元是未配对的代理字符，无法进行无损 UTF-8 编码。`,
    );
  }

  const bytes = new TextEncoder().encode(input);
  const alphabet = alphabetFor(variant);
  let output = "";

  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index]!;
    const hasSecond = index + 1 < bytes.length;
    const hasThird = index + 2 < bytes.length;
    const second = hasSecond ? bytes[index + 1]! : 0;
    const third = hasThird ? bytes[index + 2]! : 0;
    const block = (first << 16) | (second << 8) | third;

    output += alphabet[(block >>> 18) & 0x3f];
    output += alphabet[(block >>> 12) & 0x3f];
    output += hasSecond ? alphabet[(block >>> 6) & 0x3f] : "=";
    output += hasThird ? alphabet[block & 0x3f] : "=";
  }

  return variant === "url" ? output.replace(/=+$/u, "") : output;
}

/**
 * Strictly decodes Base64 into UTF-8 text.
 *
 * Standard Base64 requires RFC 4648 padding. Base64URL accepts its common
 * unpadded form as well as correctly padded input. Both variants reject
 * whitespace, mixed alphabets, misplaced padding, non-zero pad bits, and
 * byte sequences that are not valid UTF-8.
 */
export function decodeBase64(
  input: string,
  variant: Base64Variant = "standard",
): Base64DecodeResult {
  const normalized = normalizeBase64(input, variant);

  if (!normalized.ok) {
    return normalized;
  }

  const alphabet = alphabetFor(variant);
  const bytes: number[] = [];

  for (let index = 0; index < normalized.value.length; index += 4) {
    const first = alphabet.indexOf(normalized.value[index]!);
    const second = alphabet.indexOf(normalized.value[index + 1]!);
    const thirdCharacter = normalized.value[index + 2]!;
    const fourthCharacter = normalized.value[index + 3]!;
    const third = thirdCharacter === "=" ? 0 : alphabet.indexOf(thirdCharacter);
    const fourth =
      fourthCharacter === "=" ? 0 : alphabet.indexOf(fourthCharacter);
    const block = (first << 18) | (second << 12) | (third << 6) | fourth;

    bytes.push((block >>> 16) & 0xff);
    if (thirdCharacter !== "=") {
      bytes.push((block >>> 8) & 0xff);
    }
    if (fourthCharacter !== "=") {
      bytes.push(block & 0xff);
    }
  }

  try {
    return {
      ok: true,
      value: new TextDecoder("utf-8", { fatal: true }).decode(
        Uint8Array.from(bytes),
      ),
    };
  } catch {
    return failure(
      "INVALID_UTF8",
      "Base64 数据不是有效的 UTF-8 文本，无法安全显示。",
    );
  }
}

function normalizeBase64(
  input: string,
  variant: Base64Variant,
): { ok: true; value: string } | { ok: false; error: Base64DecodeError } {
  if (input === "") {
    return { ok: true, value: "" };
  }

  const alphabet = alphabetFor(variant);
  const firstPadding = input.indexOf("=");
  const dataEnd = firstPadding === -1 ? input.length : firstPadding;

  for (let index = 0; index < dataEnd; index += 1) {
    if (!alphabet.includes(input[index]!)) {
      return failure(
        "INVALID_CHARACTER",
        `第 ${index + 1} 个字符 ${JSON.stringify(input[index])} 不属于${variant === "url" ? " Base64URL" : "标准 Base64"} 字母表。`,
        index,
      );
    }
  }

  for (let index = dataEnd; index < input.length; index += 1) {
    if (input[index] !== "=") {
      return failure(
        "INVALID_PADDING",
        "填充字符 = 只能连续出现在输入末尾。",
        index,
      );
    }
  }

  const paddingLength = input.length - dataEnd;
  const remainder = dataEnd % 4;

  if (paddingLength > 2) {
    return failure(
      "INVALID_PADDING",
      "Base64 末尾最多只能有两个 = 填充字符。",
      dataEnd + 2,
    );
  }

  if (remainder === 1) {
    return failure(
      "INVALID_LENGTH",
      "Base64 有效字符数不能比 4 的倍数多 1。",
      dataEnd,
    );
  }

  if (paddingLength > 0) {
    const expectedPadding = remainder === 2 ? 2 : remainder === 3 ? 1 : 0;

    if (input.length % 4 !== 0 || paddingLength !== expectedPadding) {
      return failure(
        "INVALID_PADDING",
        "Base64 的 = 填充数量或位置不正确。",
        firstPadding,
      );
    }
  } else if (variant === "standard" && remainder !== 0) {
    return failure(
      "INVALID_PADDING",
      "标准 Base64 必须使用正确的 = 补齐到 4 的倍数。",
      dataEnd,
    );
  }

  if (remainder === 2 || remainder === 3) {
    const lastValue = alphabet.indexOf(input[dataEnd - 1]!);
    const unusedBitMask = remainder === 2 ? 0x0f : 0x03;

    if ((lastValue & unusedBitMask) !== 0) {
      return failure(
        "NON_CANONICAL_ENCODING",
        "Base64 末组包含非零填充位，不是规范编码。",
        dataEnd - 1,
      );
    }
  }

  const synthesizedPadding =
    paddingLength === 0 && remainder !== 0 ? "=".repeat(4 - remainder) : "";
  return { ok: true, value: input + synthesizedPadding };
}

function alphabetFor(variant: Base64Variant): string {
  return variant === "url" ? URL_ALPHABET : STANDARD_ALPHABET;
}

function findUnpairedSurrogate(input: string): number {
  for (let index = 0; index < input.length; index += 1) {
    const codeUnit = input.charCodeAt(index);

    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = input.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return index;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return index;
    }
  }

  return -1;
}

function failure(
  code: Base64DecodeErrorCode,
  message: string,
  offset?: number,
): { ok: false; error: Base64DecodeError } {
  return {
    ok: false,
    error: offset === undefined ? { code, message } : { code, message, offset },
  };
}

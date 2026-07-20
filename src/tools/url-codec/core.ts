export type UrlCodecMode = "component" | "url";

export type UrlCodecOperation = "encode" | "decode";

export interface UrlCodecOptions {
  /**
   * Uses the `application/x-www-form-urlencoded` convention for spaces.
   * In full-URL mode this applies only between `?` and `#`.
   */
  formEncoding?: boolean;
}

export interface UrlCodecErrorDetails {
  /** Zero-based UTF-16 offset, suitable for textarea selection APIs. */
  offset: number;
  /** One-based line number. */
  line: number;
  /** One-based, Unicode code-point-aware column number. */
  column: number;
  message: string;
  context: string;
  pointer: string;
}

export type UrlCodecResult =
  { ok: true; value: string } | { ok: false; error: UrlCodecErrorDetails };

const URI_SAFE_CHARACTERS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789;,/?:@&=+$#[]-_.!~*'()";

/** Encodes one URL component. Structural URL delimiters are encoded too. */
export function encodeUrlComponent(
  input: string,
  options: UrlCodecOptions = {},
): UrlCodecResult {
  const invalidSurrogate = findUnpairedSurrogate(input);
  if (invalidSurrogate !== -1) {
    return failure(
      input,
      invalidSurrogate,
      "输入包含未配对的 Unicode 代理字符，无法进行 UTF-8 编码。",
    );
  }

  const value = encodeURIComponent(input);
  return {
    ok: true,
    value: options.formEncoding ? value.replaceAll("%20", "+") : value,
  };
}

/** Decodes one URL component. A literal `+` is preserved unless opted in. */
export function decodeUrlComponent(
  input: string,
  options: UrlCodecOptions = {},
): UrlCodecResult {
  const percentError = validatePercentEscapes(input);
  if (percentError) {
    return failure(input, percentError.offset, percentError.message);
  }

  const utf8Error = validatePercentUtf8(input);
  if (utf8Error) {
    return failure(input, utf8Error.offset, utf8Error.message);
  }

  const source = options.formEncoding ? input.replaceAll("+", "%20") : input;
  return safelyDecode(input, source, decodeURIComponent);
}

/**
 * Encodes a full URL as text while retaining URL separators and valid existing
 * percent escapes. It never constructs, opens, or requests the supplied URL.
 */
export function encodeFullUrl(
  input: string,
  options: UrlCodecOptions = {},
): UrlCodecResult {
  const query = queryRange(input);
  let value = "";

  for (let index = 0; index < input.length;) {
    const character = input[index] ?? "";

    if (
      character === "%" &&
      isHexDigit(input[index + 1]) &&
      isHexDigit(input[index + 2])
    ) {
      value += input.slice(index, index + 3);
      index += 3;
      continue;
    }

    const codeUnit = input.charCodeAt(index);
    if (isHighSurrogate(codeUnit)) {
      const nextCodeUnit = input.charCodeAt(index + 1);
      if (!isLowSurrogate(nextCodeUnit)) {
        return failure(
          input,
          index,
          "输入包含未配对的 Unicode 代理字符，无法进行 UTF-8 编码。",
        );
      }
    } else if (isLowSurrogate(codeUnit)) {
      return failure(
        input,
        index,
        "输入包含未配对的 Unicode 代理字符，无法进行 UTF-8 编码。",
      );
    }

    const codePoint = input.codePointAt(index);
    const current = String.fromCodePoint(codePoint ?? codeUnit);
    const inQuery = index >= query.start && index < query.end;

    if (options.formEncoding && inQuery && current === " ") {
      value += "+";
    } else if (options.formEncoding && inQuery && current === "+") {
      value += "%2B";
    } else if (URI_SAFE_CHARACTERS.includes(current)) {
      value += current;
    } else {
      value += encodeURIComponent(current);
    }

    index += current.length;
  }

  return { ok: true, value };
}

/**
 * Decodes a full URL without decoding escaped structural delimiters such as
 * `%2F`, `%3F`, and `%26`. No network or navigation API is used.
 */
export function decodeFullUrl(
  input: string,
  options: UrlCodecOptions = {},
): UrlCodecResult {
  const percentError = validatePercentEscapes(input);
  if (percentError) {
    return failure(input, percentError.offset, percentError.message);
  }

  const utf8Error = validatePercentUtf8(input);
  if (utf8Error) {
    return failure(input, utf8Error.offset, utf8Error.message);
  }

  const sourceWithFormSpaces = options.formEncoding
    ? replaceQueryPlusesWithSpaces(input)
    : input;
  // `decodeURI` deliberately preserves every escaped reserved character.
  // An escaped plus is data rather than a URL separator, so decoding it here
  // gives query values an unambiguous round trip without touching `%26`/`%3D`.
  const source = sourceWithFormSpaces.replace(/%2b/gi, "+");
  return safelyDecode(input, source, decodeURI);
}

/** Dispatches to the selected operation and URL scope. */
export function transformUrl(
  input: string,
  operation: UrlCodecOperation,
  mode: UrlCodecMode,
  options: UrlCodecOptions = {},
): UrlCodecResult {
  if (operation === "encode") {
    return mode === "component"
      ? encodeUrlComponent(input, options)
      : encodeFullUrl(input, options);
  }

  return mode === "component"
    ? decodeUrlComponent(input, options)
    : decodeFullUrl(input, options);
}

function safelyDecode(
  originalInput: string,
  source: string,
  decoder: (value: string) => string,
): UrlCodecResult {
  try {
    return { ok: true, value: decoder(source) };
  } catch (error) {
    if (!(error instanceof URIError)) {
      throw error;
    }

    const offset = originalInput.indexOf("%");
    return failure(
      originalInput,
      offset === -1 ? 0 : offset,
      "百分号转义不是有效的 UTF-8 序列，无法解码。",
    );
  }
}

function replaceQueryPlusesWithSpaces(input: string): string {
  const query = queryRange(input);
  if (query.start === input.length) {
    return input;
  }

  return `${input.slice(0, query.start)}${input
    .slice(query.start, query.end)
    .replaceAll("+", "%20")}${input.slice(query.end)}`;
}

function queryRange(input: string): { start: number; end: number } {
  const fragmentStart = input.indexOf("#");
  const queryMarker = input.indexOf("?");
  const end = fragmentStart === -1 ? input.length : fragmentStart;

  if (queryMarker === -1 || queryMarker > end) {
    return { start: input.length, end: input.length };
  }

  return { start: queryMarker + 1, end };
}

function validatePercentEscapes(
  input: string,
): { offset: number; message: string } | undefined {
  for (let index = 0; index < input.length; index += 1) {
    if (input[index] !== "%") continue;

    if (!isHexDigit(input[index + 1]) || !isHexDigit(input[index + 2])) {
      return {
        offset: index,
        message: "无效的百分号转义：% 后必须紧跟两个十六进制字符。",
      };
    }

    index += 2;
  }

  return undefined;
}

function validatePercentUtf8(
  input: string,
): { offset: number; message: string } | undefined {
  for (let index = 0; index < input.length;) {
    if (input[index] !== "%") {
      index += 1;
      continue;
    }

    const bytes: number[] = [];
    const offsets: number[] = [];

    while (input[index] === "%") {
      offsets.push(index);
      bytes.push(Number.parseInt(input.slice(index + 1, index + 3), 16));
      index += 3;
    }

    const invalidByteIndex = findInvalidUtf8Byte(bytes);
    if (invalidByteIndex !== -1) {
      return {
        offset: offsets[invalidByteIndex] ?? offsets[0] ?? 0,
        message: "百分号转义不是有效的 UTF-8 序列，无法解码。",
      };
    }
  }

  return undefined;
}

function findInvalidUtf8Byte(bytes: readonly number[]): number {
  for (let index = 0; index < bytes.length;) {
    const lead = bytes[index] ?? 0;

    if (lead <= 0x7f) {
      index += 1;
      continue;
    }

    if (lead >= 0xc2 && lead <= 0xdf) {
      if (!isContinuationByte(bytes[index + 1])) return index;
      index += 2;
      continue;
    }

    if (lead >= 0xe0 && lead <= 0xef) {
      const second = bytes[index + 1];
      const secondIsValid =
        second !== undefined &&
        (lead === 0xe0
          ? second >= 0xa0 && second <= 0xbf
          : lead === 0xed
            ? second >= 0x80 && second <= 0x9f
            : isContinuationByte(second));

      if (!secondIsValid || !isContinuationByte(bytes[index + 2])) {
        return index;
      }
      index += 3;
      continue;
    }

    if (lead >= 0xf0 && lead <= 0xf4) {
      const second = bytes[index + 1];
      const secondIsValid =
        second !== undefined &&
        (lead === 0xf0
          ? second >= 0x90 && second <= 0xbf
          : lead === 0xf4
            ? second >= 0x80 && second <= 0x8f
            : isContinuationByte(second));

      if (
        !secondIsValid ||
        !isContinuationByte(bytes[index + 2]) ||
        !isContinuationByte(bytes[index + 3])
      ) {
        return index;
      }
      index += 4;
      continue;
    }

    return index;
  }

  return -1;
}

function isContinuationByte(byte: number | undefined): boolean {
  return byte !== undefined && byte >= 0x80 && byte <= 0xbf;
}

function findUnpairedSurrogate(input: string): number {
  for (let index = 0; index < input.length; index += 1) {
    const codeUnit = input.charCodeAt(index);

    if (isHighSurrogate(codeUnit)) {
      if (!isLowSurrogate(input.charCodeAt(index + 1))) return index;
      index += 1;
    } else if (isLowSurrogate(codeUnit)) {
      return index;
    }
  }

  return -1;
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

function isHexDigit(character: string | undefined): boolean {
  return character !== undefined && /^[\dA-Fa-f]$/.test(character);
}

function failure(
  source: string,
  offset: number,
  message: string,
): UrlCodecResult {
  const location = locateOffset(source, offset);
  const excerpt = lineExcerpt(source, offset);

  return {
    ok: false,
    error: {
      offset,
      line: location.line,
      column: location.column,
      message,
      context: excerpt.context,
      pointer: `${" ".repeat(excerpt.pointerColumn)}^`,
    },
  };
}

function locateOffset(
  source: string,
  offset: number,
): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;

  for (let index = 0; index < offset; index += 1) {
    const character = source[index];
    if (character === "\r") {
      line += 1;
      if (source[index + 1] === "\n") index += 1;
      lineStart = index + 1;
    } else if (character === "\n") {
      line += 1;
      lineStart = index + 1;
    }
  }

  return {
    line,
    column: Array.from(source.slice(lineStart, offset)).length + 1,
  };
}

function lineExcerpt(
  source: string,
  offset: number,
): { context: string; pointerColumn: number } {
  let lineStart = offset;
  while (
    lineStart > 0 &&
    source[lineStart - 1] !== "\n" &&
    source[lineStart - 1] !== "\r"
  ) {
    lineStart -= 1;
  }

  let lineEnd = offset;
  while (
    lineEnd < source.length &&
    source[lineEnd] !== "\n" &&
    source[lineEnd] !== "\r"
  ) {
    lineEnd += 1;
  }

  const lineCharacters = Array.from(source.slice(lineStart, lineEnd));
  const errorColumn = Array.from(source.slice(lineStart, offset)).length;
  const windowStart = Math.max(0, errorColumn - 32);
  const windowEnd = Math.min(lineCharacters.length, windowStart + 80);

  return {
    context: lineCharacters.slice(windowStart, windowEnd).join(""),
    pointerColumn: errorColumn - windowStart,
  };
}

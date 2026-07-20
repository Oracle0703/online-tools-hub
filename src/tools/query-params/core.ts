export const MAX_QUERY_INPUT_BYTES = 2 * 1024 * 1024;
export const MAX_QUERY_PARAMETERS = 10_000;

export type QueryEncoding = "rfc3986" | "form";

export type QuerySourceKind = "url" | "query" | "bare";

export interface QueryParameter {
  key: string;
  value: string;
  /** Distinguishes `flag` from `flag=` and an empty segment from `=`. */
  hasEquals: boolean;
}

export interface ParsedQueryDocument {
  sourceKind: QuerySourceKind;
  /** Everything before `?` for a URL input. Empty for query-only input. */
  base: string;
  /** Includes the leading `#` when present. */
  fragment: string;
  /** Preserves a trailing `?` even when the URL has no parameters. */
  hadQueryMarker: boolean;
  parameters: QueryParameter[];
}

export type QueryErrorCode =
  | "input-too-large"
  | "too-many-parameters"
  | "invalid-percent-escape"
  | "invalid-utf8"
  | "invalid-unicode";

export interface QueryErrorDetails {
  code: QueryErrorCode;
  /** Zero-based UTF-16 offset, suitable for textarea selection APIs. */
  offset: number;
  /** One-based line number. */
  line: number;
  /** One-based, Unicode-code-point-aware column number. */
  column: number;
  /** One-based parameter position when the error is inside a query item. */
  parameterIndex?: number;
  message: string;
  context: string;
  pointer: string;
}

export type QueryParseResult =
  | { ok: true; value: ParsedQueryDocument }
  | { ok: false; error: QueryErrorDetails };

export type QueryBuildResult =
  { ok: true; value: string } | { ok: false; error: QueryErrorDetails };

export interface QueryCodecOptions {
  encoding?: QueryEncoding;
}

/**
 * Parses an absolute/relative URL, a `?query` value, or a bare query string.
 * No URL is opened, normalized, or sent to a network API.
 */
export function parseQueryInput(
  input: string,
  options: QueryCodecOptions = {},
): QueryParseResult {
  const inputBytes = new TextEncoder().encode(input).byteLength;
  if (inputBytes > MAX_QUERY_INPUT_BYTES) {
    return queryFailure(
      input,
      input.length,
      "input-too-large",
      "输入超过 2 MiB 上限，请缩减内容后再解析。",
    );
  }

  const source = splitQuerySource(input);
  const queryOffset = source.queryOffset;
  const query = source.query;

  if (query.length === 0) {
    return {
      ok: true,
      value: {
        sourceKind: source.sourceKind,
        base: source.base,
        fragment: source.fragment,
        hadQueryMarker: source.hadQueryMarker,
        parameters: [],
      },
    };
  }

  const encoding = options.encoding ?? "rfc3986";
  const parameters: QueryParameter[] = [];
  let segmentStart = 0;

  while (segmentStart <= query.length) {
    if (parameters.length >= MAX_QUERY_PARAMETERS) {
      return queryFailure(
        input,
        queryOffset + segmentStart,
        "too-many-parameters",
        `查询参数超过 ${MAX_QUERY_PARAMETERS.toLocaleString("en-US")} 项安全上限。`,
        parameters.length + 1,
      );
    }

    const separator = query.indexOf("&", segmentStart);
    const segmentEnd = separator === -1 ? query.length : separator;
    const segment = query.slice(segmentStart, segmentEnd);
    const equalsOffset = segment.indexOf("=");
    const hasEquals = equalsOffset !== -1;
    const rawKey = hasEquals ? segment.slice(0, equalsOffset) : segment;
    const rawValue = hasEquals ? segment.slice(equalsOffset + 1) : "";
    const parameterIndex = parameters.length + 1;

    const keyResult = decodeQueryPart(
      rawKey,
      input,
      queryOffset + segmentStart,
      encoding,
      parameterIndex,
    );
    if (!keyResult.ok) return keyResult;

    const valueResult = decodeQueryPart(
      rawValue,
      input,
      queryOffset + segmentStart + (hasEquals ? equalsOffset + 1 : 0),
      encoding,
      parameterIndex,
    );
    if (!valueResult.ok) return valueResult;

    parameters.push({
      key: keyResult.value,
      value: valueResult.value,
      hasEquals,
    });

    if (separator === -1) break;
    segmentStart = separator + 1;
  }

  return {
    ok: true,
    value: {
      sourceKind: source.sourceKind,
      base: source.base,
      fragment: source.fragment,
      hadQueryMarker: source.hadQueryMarker,
      parameters,
    },
  };
}

/** Serializes decoded parameters without sorting or deduplicating them. */
export function buildQueryString(
  parameters: readonly QueryParameter[],
  options: QueryCodecOptions = {},
): QueryBuildResult {
  const encoding = options.encoding ?? "rfc3986";
  const segments: string[] = [];

  for (const [index, parameter] of parameters.entries()) {
    const encodedKey = encodeQueryPart(parameter.key, index + 1, encoding);
    if (!encodedKey.ok) return encodedKey;

    if (!parameter.hasEquals) {
      segments.push(encodedKey.value);
      continue;
    }

    const encodedValue = encodeQueryPart(parameter.value, index + 1, encoding);
    if (!encodedValue.ok) return encodedValue;
    segments.push(`${encodedKey.value}=${encodedValue.value}`);
  }

  return { ok: true, value: segments.join("&") };
}

/** Rebuilds the same source shape while retaining its base and fragment. */
export function rebuildQueryInput(
  document: Pick<
    ParsedQueryDocument,
    "sourceKind" | "base" | "fragment" | "hadQueryMarker"
  >,
  parameters: readonly QueryParameter[],
  options: QueryCodecOptions = {},
): QueryBuildResult {
  const queryResult = buildQueryString(parameters, options);
  if (!queryResult.ok) return queryResult;

  const query = queryResult.value;
  switch (document.sourceKind) {
    case "url": {
      const marker =
        query.length > 0 || document.hadQueryMarker ? `?${query}` : "";
      return {
        ok: true,
        value: `${document.base}${marker}${document.fragment}`,
      };
    }
    case "query":
      return { ok: true, value: `?${query}${document.fragment}` };
    case "bare":
      return { ok: true, value: `${query}${document.fragment}` };
  }
}

/** Stable, explicit sort by decoded key. Duplicate-key value order is retained. */
export function sortQueryParameters<T extends QueryParameter>(
  parameters: readonly T[],
): T[] {
  return parameters
    .map((parameter, index) => ({ parameter, index }))
    .sort((left, right) => {
      if (left.parameter.key < right.parameter.key) return -1;
      if (left.parameter.key > right.parameter.key) return 1;
      return left.index - right.index;
    })
    .map(({ parameter }) => parameter);
}

/** Produces an order-preserving JSON representation with `null` for no `=`. */
export function exportQueryParametersJson(
  document: Pick<ParsedQueryDocument, "sourceKind" | "base" | "fragment">,
  parameters: readonly QueryParameter[],
  encoding: QueryEncoding,
): string {
  return JSON.stringify(
    {
      source: {
        kind: document.sourceKind,
        base: document.base,
        fragment: document.fragment,
      },
      encoding,
      parameters: parameters.map((parameter) => ({
        key: parameter.key,
        value: parameter.hasEquals ? parameter.value : null,
        hasEquals: parameter.hasEquals,
      })),
    },
    null,
    2,
  );
}

interface SplitQuerySource {
  sourceKind: QuerySourceKind;
  base: string;
  query: string;
  fragment: string;
  hadQueryMarker: boolean;
  queryOffset: number;
}

function splitQuerySource(input: string): SplitQuerySource {
  const fragmentOffset = input.indexOf("#");
  const beforeFragment =
    fragmentOffset === -1 ? input : input.slice(0, fragmentOffset);
  const fragment = fragmentOffset === -1 ? "" : input.slice(fragmentOffset);
  const queryMarkerOffset = beforeFragment.indexOf("?");

  if (queryMarkerOffset !== -1) {
    const base = beforeFragment.slice(0, queryMarkerOffset);
    return {
      sourceKind: base.length > 0 ? "url" : "query",
      base,
      query: beforeFragment.slice(queryMarkerOffset + 1),
      fragment,
      hadQueryMarker: true,
      queryOffset: queryMarkerOffset + 1,
    };
  }

  if (looksLikeUrlWithoutQuery(beforeFragment)) {
    return {
      sourceKind: "url",
      base: beforeFragment,
      query: "",
      fragment,
      hadQueryMarker: false,
      queryOffset: beforeFragment.length,
    };
  }

  return {
    sourceKind: "bare",
    base: "",
    query: beforeFragment,
    fragment,
    hadQueryMarker: false,
    queryOffset: 0,
  };
}

function looksLikeUrlWithoutQuery(input: string): boolean {
  return /^(?:[A-Za-z][A-Za-z\d+.-]*:|\/\/)/u.test(input);
}

type DecodedPartResult =
  { ok: true; value: string } | { ok: false; error: QueryErrorDetails };

function decodeQueryPart(
  rawPart: string,
  fullInput: string,
  globalOffset: number,
  encoding: QueryEncoding,
  parameterIndex: number,
): DecodedPartResult {
  const surrogateOffset = findUnpairedSurrogate(rawPart);
  if (surrogateOffset !== -1) {
    return queryFailure(
      fullInput,
      globalOffset + surrogateOffset,
      "invalid-unicode",
      "参数包含未配对的 Unicode 代理字符，无法安全编码。",
      parameterIndex,
    );
  }

  const percentError = validatePercentEncoding(rawPart);
  if (percentError) {
    return queryFailure(
      fullInput,
      globalOffset + percentError.offset,
      percentError.code,
      percentError.message,
      parameterIndex,
    );
  }

  const source = encoding === "form" ? rawPart.replaceAll("+", "%20") : rawPart;
  return { ok: true, value: decodeURIComponent(source) };
}

function encodeQueryPart(
  value: string,
  parameterIndex: number,
  encoding: QueryEncoding,
): QueryBuildResult {
  const surrogateOffset = findUnpairedSurrogate(value);
  if (surrogateOffset !== -1) {
    return queryFailure(
      value,
      surrogateOffset,
      "invalid-unicode",
      "参数包含未配对的 Unicode 代理字符，无法安全编码。",
      parameterIndex,
    );
  }

  const percentEncoded = encodeURIComponent(value).replace(
    /[!'()*]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return {
    ok: true,
    value:
      encoding === "form"
        ? percentEncoded.replaceAll("%20", "+")
        : percentEncoded,
  };
}

function validatePercentEncoding(input: string):
  | {
      offset: number;
      code: "invalid-percent-escape" | "invalid-utf8";
      message: string;
    }
  | undefined {
  for (let index = 0; index < input.length;) {
    if (input[index] !== "%") {
      index += 1;
      continue;
    }

    if (!isHexDigit(input[index + 1]) || !isHexDigit(input[index + 2])) {
      return {
        offset: index,
        code: "invalid-percent-escape",
        message: "无效的百分号转义：% 后必须紧跟两个十六进制字符。",
      };
    }

    const bytes: number[] = [];
    const offsets: number[] = [];
    while (input[index] === "%") {
      if (!isHexDigit(input[index + 1]) || !isHexDigit(input[index + 2])) {
        return {
          offset: index,
          code: "invalid-percent-escape",
          message: "无效的百分号转义：% 后必须紧跟两个十六进制字符。",
        };
      }
      offsets.push(index);
      bytes.push(Number.parseInt(input.slice(index + 1, index + 3), 16));
      index += 3;
    }

    const invalidByteIndex = findInvalidUtf8Byte(bytes);
    if (invalidByteIndex !== -1) {
      return {
        offset: offsets[invalidByteIndex] ?? offsets[0] ?? 0,
        code: "invalid-utf8",
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
      if (!secondIsValid || !isContinuationByte(bytes[index + 2])) return index;
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

function queryFailure(
  input: string,
  offset: number,
  code: QueryErrorCode,
  message: string,
  parameterIndex?: number,
): { ok: false; error: QueryErrorDetails } {
  const safeOffset = Math.max(0, Math.min(offset, input.length));
  const lineStart = input.lastIndexOf("\n", Math.max(0, safeOffset - 1)) + 1;
  const lineEnd = input.indexOf("\n", safeOffset);
  const fullLine = input.slice(
    lineStart,
    lineEnd === -1 ? input.length : lineEnd,
  );
  const offsetInLine = safeOffset - lineStart;
  const windowStart = Math.max(0, offsetInLine - 48);
  const windowEnd = Math.min(fullLine.length, offsetInLine + 49);
  const before = fullLine.slice(0, offsetInLine);
  const beforeWindow = fullLine.slice(windowStart, offsetInLine);
  const context = `${windowStart > 0 ? "…" : ""}${fullLine.slice(windowStart, windowEnd)}${
    windowEnd < fullLine.length ? "…" : ""
  }`;
  const pointerColumn =
    Array.from(beforeWindow).length + (windowStart > 0 ? 1 : 0);

  return {
    ok: false,
    error: {
      code,
      offset: safeOffset,
      line: input.slice(0, safeOffset).split("\n").length,
      column: Array.from(before).length + 1,
      parameterIndex,
      message,
      context,
      pointer: `${" ".repeat(pointerColumn)}^`,
    },
  };
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

function isContinuationByte(byte: number | undefined): boolean {
  return byte !== undefined && byte >= 0x80 && byte <= 0xbf;
}

function isHexDigit(character: string | undefined): boolean {
  return character !== undefined && /^[\dA-Fa-f]$/u.test(character);
}

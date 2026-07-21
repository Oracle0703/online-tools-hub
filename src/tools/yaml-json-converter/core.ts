import {
  parseAllDocuments,
  stringify,
  visit,
  type Document,
  type Scalar,
} from "yaml";

import { validateJson } from "../json-formatter";

export const MAX_YAML_JSON_INPUT_BYTES = 2 * 1024 * 1024;
export const MAX_YAML_ALIAS_COUNT = 50;
export const MAX_YAML_JSON_NESTING_DEPTH = 100;
export const MAX_YAML_JSON_NODES = 100_000;
export const MAX_YAML_JSON_OUTPUT_BYTES = 16 * 1024 * 1024;

export type YamlJsonDirection = "yaml-to-json" | "json-to-yaml";
export type JsonOutputIndent = 2 | 4;

export type YamlJsonErrorKind =
  | "input-limit"
  | "syntax"
  | "multiple-documents"
  | "alias-limit"
  | "node-limit"
  | "output-limit"
  | "unsupported-value";

export interface YamlJsonErrorDetails {
  kind: YamlJsonErrorKind;
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

export type YamlJsonTransformResult =
  { ok: true; value: string } | { ok: false; error: YamlJsonErrorDetails };

export interface YamlJsonTransformOptions {
  jsonIndent?: JsonOutputIndent;
}

class ConversionFailure extends Error {
  constructor(
    readonly kind: YamlJsonErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "ConversionFailure";
  }
}

class JsonConversionBudget {
  private nodes = 0;
  private outputBytes = 0;

  constructor(private readonly indent: JsonOutputIndent) {}

  reserveNode(): void {
    if (this.nodes >= MAX_YAML_JSON_NODES) {
      throw new ConversionFailure(
        "node-limit",
        `YAML 别名展开后的 JSON 超过 ${MAX_YAML_JSON_NODES.toLocaleString("zh-CN")} 个语义节点上限。`,
      );
    }
    this.nodes += 1;
  }

  addScalar(value: null | string | boolean | number): void {
    if (typeof value === "string") {
      this.addOutputBytes(jsonStringUtf8ByteLength(value));
      return;
    }

    if (value === null) {
      this.addOutputBytes(4);
      return;
    }

    this.addOutputBytes(String(value).length);
  }

  addContainerFormatting(itemCount: number, depth: number): void {
    if (itemCount === 0) {
      this.addOutputBytes(2);
      return;
    }

    const structuralBytes =
      4 +
      itemCount * this.indent * (depth + 1) +
      (itemCount - 1) * 2 +
      this.indent * depth;
    this.addOutputBytes(structuralBytes);
  }

  addObjectKey(key: string): void {
    this.addOutputBytes(jsonStringUtf8ByteLength(key) + 2);
  }

  private addOutputBytes(bytes: number): void {
    if (
      !Number.isSafeInteger(bytes) ||
      bytes > MAX_YAML_JSON_OUTPUT_BYTES - this.outputBytes
    ) {
      throw outputLimitFailure();
    }
    this.outputBytes += bytes;
  }
}

function outputLimitFailure(): ConversionFailure {
  return new ConversionFailure(
    "output-limit",
    `转换结果超过 ${formatMebibytes(MAX_YAML_JSON_OUTPUT_BYTES)} MiB 上限。`,
  );
}

/**
 * Converts exactly one YAML 1.2 Core Schema document into JSON.
 *
 * Custom tags and merge keys are disabled. Aliases are expanded with a strict
 * limit before the result is normalised to JSON-compatible values.
 */
export function yamlToJson(
  input: string,
  indent: JsonOutputIndent = 2,
): YamlJsonTransformResult {
  const limitError = checkInputLimit(input);
  if (limitError) return limitError;

  if (!input.trim()) {
    return failureAt(input, 0, "syntax", "请输入一个 YAML 文档。");
  }

  let documents: Document.Parsed[];

  try {
    documents = parseAllDocuments(input, {
      customTags: [],
      intAsBigInt: true,
      merge: false,
      prettyErrors: false,
      resolveKnownTags: false,
      schema: "core",
      strict: true,
      stringKeys: true,
      uniqueKeys: true,
      version: "1.2",
    });
  } catch (error) {
    return unexpectedFailure(input, error, "YAML 解析失败。");
  }

  if (documents.length === 0) {
    return failureAt(
      input,
      0,
      "syntax",
      "YAML 中只有注释或指令，没有可转换的文档内容。",
    );
  }

  if (documents.length > 1) {
    const secondDocumentOffset = documents[1]?.range?.[0] ?? input.length;
    return failureAt(
      input,
      secondDocumentOffset,
      "multiple-documents",
      "仅支持单个 YAML 文档，请移除第二个 --- 文档分隔符及其内容。",
    );
  }

  const document = documents[0];
  if (!document) {
    return failureAt(input, 0, "syntax", "YAML 文档无法解析。");
  }
  const parseIssue = document.errors[0] ?? document.warnings[0];

  if (parseIssue) {
    return failureAt(
      input,
      parseIssue.pos[0],
      "syntax",
      normalizeParserMessage(parseIssue.message),
    );
  }

  const numericIssue = findLossyYamlNumber(document);
  if (numericIssue) {
    return failureAt(
      input,
      numericIssue.offset,
      "unsupported-value",
      numericIssue.message,
    );
  }

  try {
    const parsed = document.toJS({
      mapAsMap: true,
      maxAliasCount: MAX_YAML_ALIAS_COUNT,
    }) as unknown;
    const budget = new JsonConversionBudget(indent);
    const jsonValue = normalizeJsonValue(
      parsed,
      new WeakSet<object>(),
      0,
      budget,
    );
    const output = JSON.stringify(jsonValue, null, indent);
    if (output === undefined) {
      throw new ConversionFailure(
        "unsupported-value",
        "YAML 顶层值无法表示为 JSON。",
      );
    }
    if (utf8ByteLength(output) > MAX_YAML_JSON_OUTPUT_BYTES) {
      throw outputLimitFailure();
    }

    return { ok: true, value: output };
  } catch (error) {
    if (error instanceof ConversionFailure) {
      return failureAt(input, 0, error.kind, error.message);
    }

    const message = error instanceof Error ? error.message : "";
    if (/alias|anchor|resource exhaustion/i.test(message)) {
      return failureAt(
        input,
        0,
        "alias-limit",
        `YAML 别名展开超过 ${MAX_YAML_ALIAS_COUNT} 次安全上限。`,
      );
    }

    return unexpectedFailure(input, error, "YAML 无法安全转换为 JSON。");
  }
}

/** Converts strict JSON into a single YAML 1.2 Core Schema document. */
export function jsonToYaml(input: string): YamlJsonTransformResult {
  const limitError = checkInputLimit(input);
  if (limitError) return limitError;

  const validation = validateJson(input);
  if (!validation.ok) {
    return {
      ok: false,
      error: {
        kind: "syntax",
        ...validation.error,
        message: `JSON 语法错误：${validation.error.message}`,
      },
    };
  }

  const lossyNumber = findLossyJsonNumber(input);
  if (lossyNumber) {
    return failureAt(
      input,
      lossyNumber.offset,
      "unsupported-value",
      "JSON 数字无法在转换中保持原值；请将它改为字符串，避免精度丢失。",
    );
  }

  try {
    const value = JSON.parse(input) as unknown;
    const output = stringify(value, {
      aliasDuplicateObjects: false,
      customTags: [],
      indent: 2,
      lineWidth: 0,
      merge: false,
      resolveKnownTags: false,
      schema: "core",
      sortMapEntries: false,
      version: "1.2",
    });
    if (utf8ByteLength(output) > MAX_YAML_JSON_OUTPUT_BYTES) {
      return failureAt(
        input,
        0,
        "output-limit",
        `转换结果超过 ${formatMebibytes(MAX_YAML_JSON_OUTPUT_BYTES)} MiB 上限。`,
      );
    }
    return {
      ok: true,
      value: output,
    };
  } catch (error) {
    return unexpectedFailure(input, error, "JSON 无法转换为 YAML。");
  }
}

export function transformYamlJson(
  input: string,
  direction: YamlJsonDirection,
  options: YamlJsonTransformOptions = {},
): YamlJsonTransformResult {
  return direction === "yaml-to-json"
    ? yamlToJson(input, options.jsonIndent ?? 2)
    : jsonToYaml(input);
}

function checkInputLimit(
  input: string,
): { ok: false; error: YamlJsonErrorDetails } | undefined {
  const byteLength = new TextEncoder().encode(input).byteLength;
  if (byteLength <= MAX_YAML_JSON_INPUT_BYTES) return undefined;

  return failureAt(
    input,
    input.length,
    "input-limit",
    "输入超过 2 MiB 上限，请缩减内容后再试。",
  );
}

function normalizeJsonValue(
  value: unknown,
  activeContainers: WeakSet<object>,
  depth: number,
  budget: JsonConversionBudget,
): unknown {
  budget.reserveNode();

  if (depth > MAX_YAML_JSON_NESTING_DEPTH) {
    throw new ConversionFailure(
      "unsupported-value",
      `YAML 嵌套超过 ${MAX_YAML_JSON_NESTING_DEPTH} 层，无法安全转换。`,
    );
  }

  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    budget.addScalar(value);
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new ConversionFailure(
        "unsupported-value",
        "YAML 包含 Infinity 或 NaN；JSON 只支持有限数字。",
      );
    }
    budget.addScalar(value);
    return value;
  }

  if (typeof value === "bigint") {
    const numberValue = Number(value);
    if (!Number.isFinite(numberValue) || BigInt(numberValue) !== value) {
      throw new ConversionFailure(
        "unsupported-value",
        "YAML 数字无法在 JSON 中保持原值；请将它写成字符串。",
      );
    }
    budget.addScalar(numberValue);
    return numberValue;
  }

  if (typeof value !== "object") {
    throw new ConversionFailure(
      "unsupported-value",
      `YAML 包含 JSON 不支持的 ${typeof value} 值。`,
    );
  }

  if (activeContainers.has(value)) {
    throw new ConversionFailure(
      "alias-limit",
      "YAML 别名形成循环引用，无法表示为 JSON。",
    );
  }

  activeContainers.add(value);

  try {
    if (Array.isArray(value)) {
      budget.addContainerFormatting(value.length, depth);
      const normalized: unknown[] = [];
      for (const item of value) {
        normalized.push(
          normalizeJsonValue(item, activeContainers, depth + 1, budget),
        );
      }
      return normalized;
    }

    if (value instanceof Map) {
      budget.addContainerFormatting(value.size, depth);
      const record: Record<string, unknown> = Object.create(null) as Record<
        string,
        unknown
      >;

      for (const [key, item] of value) {
        if (typeof key !== "string") {
          throw new ConversionFailure(
            "unsupported-value",
            "YAML 映射键必须是字符串，才能转换为 JSON 对象。",
          );
        }
        budget.addObjectKey(key);
        const normalizedItem = normalizeJsonValue(
          item,
          activeContainers,
          depth + 1,
          budget,
        );
        record[key] = normalizedItem;
      }

      return record;
    }

    throw new ConversionFailure(
      "unsupported-value",
      "YAML 包含 JSON 无法表示的对象类型。",
    );
  } finally {
    activeContainers.delete(value);
  }
}

function unexpectedFailure(
  input: string,
  error: unknown,
  fallbackMessage: string,
): { ok: false; error: YamlJsonErrorDetails } {
  const message =
    error instanceof Error && error.message.trim()
      ? error.message
      : fallbackMessage;
  return failureAt(input, 0, "syntax", message);
}

function normalizeParserMessage(message: string): string {
  return message.replace(/\s+at line \d+, column \d+.*$/su, "").trim();
}

type DecimalValue = {
  negative: boolean;
  digits: string;
  exponent: bigint;
};

type NumericIssue = {
  offset: number;
  message: string;
};

function findLossyYamlNumber(document: Document.Parsed): NumericIssue | null {
  let issue: NumericIssue | null = null;

  visit(document, {
    Scalar(_key, scalar) {
      if (
        typeof scalar.value !== "number" &&
        typeof scalar.value !== "bigint"
      ) {
        return;
      }

      const parsedScalar = scalar as Scalar.Parsed;
      const sourceToken = parsedScalar.source;
      const offset = parsedScalar.range[0];
      const numberValue = Number(scalar.value);

      if (!Number.isFinite(numberValue)) {
        issue = {
          offset,
          message: "YAML 包含 Infinity、NaN 或溢出数字；JSON 只支持有限数字。",
        };
        return visit.BREAK;
      }

      const outputToken = JSON.stringify(numberValue);
      const decimalSource = parseDecimalValue(sourceToken);
      const preservesValue = decimalSource
        ? numberPreservesDecimalValue(decimalSource, numberValue, outputToken)
        : typeof scalar.value === "bigint" &&
          Number.isInteger(numberValue) &&
          BigInt(numberValue) === scalar.value;

      if (!preservesValue) {
        issue = {
          offset,
          message:
            "YAML 数字无法在 JSON 中保持原值；请将它写成字符串，避免精度丢失。",
        };
        return visit.BREAK;
      }
    },
  });

  return issue;
}

function findLossyJsonNumber(source: string): NumericIssue | null {
  let insideString = false;
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] ?? "";

    if (insideString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        insideString = false;
      }
      continue;
    }

    if (character === '"') {
      insideString = true;
      continue;
    }

    if (character !== "-" && (character < "0" || character > "9")) {
      continue;
    }

    const token = source
      .slice(index)
      .match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u)?.[0];
    if (!token) continue;

    const numberValue = Number(token);
    const decimalValue = parseDecimalValue(token);
    const yamlOutputToken = Object.is(numberValue, -0)
      ? "-0"
      : String(numberValue);

    if (
      !Number.isFinite(numberValue) ||
      !decimalValue ||
      !numberPreservesDecimalValue(decimalValue, numberValue, yamlOutputToken)
    ) {
      return { offset: index, message: "JSON 数字无法保持原值。" };
    }

    index += token.length - 1;
  }

  return null;
}

function numberPreservesDecimalValue(
  sourceValue: DecimalValue,
  numberValue: number,
  outputToken: string,
): boolean {
  const outputValue = parseDecimalValue(outputToken);
  if (!outputValue || !sameDecimalValue(sourceValue, outputValue)) {
    return false;
  }

  const exactInteger = decimalIntegerValue(sourceValue);
  return exactInteger === undefined || BigInt(numberValue) === exactInteger;
}

function parseDecimalValue(sourceToken: string): DecimalValue | null {
  const token = sourceToken.replaceAll("_", "");
  const match = token.match(/^([+-]?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/u);
  if (!match) return null;

  const sign = match[1] ?? "";
  const integerDigits = match[2] ?? "";
  const fractionDigits = match[3] ?? "";
  let digits = `${integerDigits}${fractionDigits}`.replace(/^0+/u, "");

  if (!digits) {
    return { negative: sign === "-", digits: "0", exponent: 0n };
  }

  const exponentPart = parseDecimalExponent(match[4] ?? "0");
  if (exponentPart === null) return null;

  const trailingZeros = digits.length - digits.replace(/0+$/u, "").length;
  if (trailingZeros > 0) digits = digits.slice(0, -trailingZeros);

  return {
    negative: sign === "-",
    digits,
    exponent:
      exponentPart - BigInt(fractionDigits.length) + BigInt(trailingZeros),
  };
}

function parseDecimalExponent(source: string): bigint | null {
  const negative = source.startsWith("-");
  const unsigned = source.replace(/^[+-]/u, "").replace(/^0+/u, "") || "0";

  // A non-zero finite Number cannot require an exponent with this magnitude.
  // Bounding it also prevents giant exponent strings from becoming BigInts.
  if (unsigned.length > 20) return null;
  const value = BigInt(unsigned);
  return negative ? -value : value;
}

function sameDecimalValue(left: DecimalValue, right: DecimalValue): boolean {
  return (
    left.negative === right.negative &&
    left.digits === right.digits &&
    left.exponent === right.exponent
  );
}

function decimalIntegerValue(value: DecimalValue): bigint | undefined {
  if (value.exponent < 0n) return undefined;

  // Finite JS numbers have at most 309 decimal integer digits.
  if (value.exponent > 400n) return undefined;

  const magnitude = BigInt(
    `${value.digits}${"0".repeat(Number(value.exponent))}`,
  );
  return value.negative ? -magnitude : magnitude;
}

function failureAt(
  source: string,
  requestedOffset: number,
  kind: YamlJsonErrorKind,
  message: string,
): { ok: false; error: YamlJsonErrorDetails } {
  const offset = Math.max(0, Math.min(requestedOffset, source.length));
  const location = locateOffset(source, offset);
  const excerpt = lineExcerpt(source, offset);

  return {
    ok: false,
    error: {
      kind,
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

  const characters = Array.from(source.slice(lineStart, lineEnd));
  const errorColumn = Array.from(source.slice(lineStart, offset)).length;
  const windowStart = Math.max(0, errorColumn - 32);

  return {
    context: characters.slice(windowStart, windowStart + 80).join(""),
    pointerColumn: errorColumn - windowStart,
  };
}

function formatMebibytes(bytes: number): number {
  return bytes / (1024 * 1024);
}

function jsonStringUtf8ByteLength(value: string): number {
  let bytes = 2;

  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c) {
      bytes += 2;
    } else if (
      code === 0x08 ||
      code === 0x09 ||
      code === 0x0a ||
      code === 0x0c ||
      code === 0x0d
    ) {
      bytes += 2;
    } else if (code <= 0x1f) {
      bytes += 6;
    } else if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      index + 1 < value.length &&
      value.charCodeAt(index + 1) >= 0xdc00 &&
      value.charCodeAt(index + 1) <= 0xdfff
    ) {
      bytes += 4;
      index += 1;
    } else if (code >= 0xd800 && code <= 0xdfff) {
      bytes += 6;
    } else {
      bytes += 3;
    }
  }

  return bytes;
}

function utf8ByteLength(value: string): number {
  let bytes = 0;

  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      index + 1 < value.length &&
      value.charCodeAt(index + 1) >= 0xdc00 &&
      value.charCodeAt(index + 1) <= 0xdfff
    ) {
      bytes += 4;
      index += 1;
    } else {
      bytes += 3;
    }
  }

  return bytes;
}

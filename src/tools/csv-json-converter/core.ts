import { validateJson } from "../json-formatter";

export const MAX_CSV_JSON_INPUT_BYTES = 2 * 1024 * 1024;
export const MAX_CSV_JSON_ROWS = 100_000;
export const MAX_CSV_JSON_CELLS = 500_000;
export const MAX_CSV_JSON_NODES = 100_000;
export const MAX_CSV_JSON_OUTPUT_BYTES = 16 * 1024 * 1024;
export const MAX_CSV_JSON_NESTING_DEPTH = 100;
export const MAX_CSV_JSON_NUMBER_CHARACTERS = 128;

export type CsvJsonDirection = "csv-to-json" | "json-to-csv";
export type CsvDelimiter = "," | ";" | "\t";
export type CsvDelimiterOption = "auto" | CsvDelimiter;
export type CsvJsonIndent = 2 | 4;

export type CsvJsonErrorKind =
  | "input-limit"
  | "row-limit"
  | "cell-limit"
  | "node-limit"
  | "output-limit"
  | "syntax"
  | "delimiter-detection"
  | "empty-header"
  | "duplicate-header"
  | "column-mismatch"
  | "unsupported-structure"
  | "unsafe-number";

export interface CsvJsonErrorDetails {
  kind: CsvJsonErrorKind;
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

export type CsvJsonTransformResult =
  | {
      ok: true;
      value: string;
      delimiter: CsvDelimiter;
      rows: number;
      columns: number;
    }
  | { ok: false; error: CsvJsonErrorDetails };

export interface CsvToJsonOptions {
  delimiter?: CsvDelimiterOption;
  jsonIndent?: CsvJsonIndent;
}

export interface JsonToCsvOptions {
  delimiter?: CsvDelimiter;
}

export interface CsvJsonTransformOptions {
  delimiter?: CsvDelimiterOption;
  jsonIndent?: CsvJsonIndent;
}

type ParsedCsv = {
  rows: string[][];
  fieldOffsets: number[][];
  rowOffsets: number[];
};

type ParseCsvResult =
  { ok: true; parsed: ParsedCsv } | { ok: false; error: CsvJsonErrorDetails };

type ValidatedCsv = {
  headers: string[];
  dataRows: string[][];
};

const DELIMITER_CANDIDATES = [",", ";", "\t"] as const;

/** Converts strict RFC 4180-style CSV into an array of string-valued objects. */
export function csvToJson(
  input: string,
  options: CsvToJsonOptions = {},
): CsvJsonTransformResult {
  const limitError = checkInputLimit(input);
  if (limitError) return limitError;

  if (!stripLeadingBom(input).trim()) {
    return failureAt(
      input,
      input.startsWith("\uFEFF") ? 1 : 0,
      "syntax",
      "请输入 CSV 表头和数据。",
    );
  }

  const requestedDelimiter = options.delimiter ?? "auto";
  let delimiter: CsvDelimiter;
  let parsed: ParsedCsv;

  if (requestedDelimiter === "auto") {
    const detected = detectDelimiter(input);
    if (!detected.ok) return detected;
    delimiter = detected.delimiter;
    parsed = detected.parsed;
  } else {
    delimiter = requestedDelimiter;
    const parseResult = parseCsv(input, delimiter);
    if (!parseResult.ok) return parseResult;
    parsed = parseResult.parsed;
  }

  const validated = validateCsvShape(input, parsed);
  if (!validated.ok) return validated;

  const output = renderCsvAsJson(
    validated.value.headers,
    validated.value.dataRows,
    options.jsonIndent ?? 2,
  );
  if (output === undefined) {
    return outputLimitFailure(input);
  }

  return {
    ok: true,
    value: output,
    delimiter,
    rows: validated.value.dataRows.length,
    columns: validated.value.headers.length,
  };
}

/** Converts a strict JSON array of flat objects into CSV. */
export function jsonToCsv(
  input: string,
  options: JsonToCsvOptions = {},
): CsvJsonTransformResult {
  const limitError = checkInputLimit(input);
  if (limitError) return limitError;

  const validation = validateJson(input);
  if (!validation.ok) {
    if (validation.error.message.includes("nesting exceeds")) {
      const nestingIssue = inspectJsonSafety(input);
      if (nestingIssue) return nestingIssue;
    }
    if (validation.error.message.includes("values and containers")) {
      return failureAt(
        input,
        validation.error.offset,
        "node-limit",
        `JSON 超过 ${MAX_CSV_JSON_NODES.toLocaleString("zh-CN")} 个语义节点上限。`,
      );
    }
    return {
      ok: false,
      error: {
        kind: "syntax",
        ...validation.error,
        message: `JSON 语法错误：${validation.error.message}`,
      },
    };
  }

  const safetyIssue = inspectJsonSafety(input);
  if (safetyIssue) return safetyIssue;

  let value: unknown;
  try {
    value = JSON.parse(input) as unknown;
  } catch (error) {
    return failureAt(
      input,
      0,
      "syntax",
      error instanceof Error ? error.message : "JSON 无法解析。",
    );
  }

  if (!Array.isArray(value)) {
    return failureAt(
      input,
      firstNonWhitespaceOffset(input),
      "unsupported-structure",
      "JSON 顶层必须是对象数组，才能转换为 CSV 表格。",
    );
  }

  if (value.length === 0) {
    return failureAt(
      input,
      firstNonWhitespaceOffset(input),
      "unsupported-structure",
      "JSON 数组为空，无法确定 CSV 表头。",
    );
  }

  if (value.length + 1 > MAX_CSV_JSON_ROWS) {
    return failureAt(
      input,
      firstNonWhitespaceOffset(input),
      "row-limit",
      `转换结果超过 ${MAX_CSV_JSON_ROWS.toLocaleString("zh-CN")} 行上限。`,
    );
  }

  const rows: Array<Record<string, unknown>> = [];
  const headers: string[] = [];
  const seenHeaders = new Set<string>();

  for (let rowIndex = 0; rowIndex < value.length; rowIndex += 1) {
    const row = value[rowIndex];
    if (!isPlainRecord(row)) {
      return failureAt(
        input,
        0,
        "unsupported-structure",
        `JSON 第 ${rowIndex + 1} 项必须是普通对象，不能是数组、null 或标量。`,
      );
    }

    for (const header of Object.keys(row)) {
      if (!header.trim()) {
        return failureAt(
          input,
          0,
          "empty-header",
          `JSON 第 ${rowIndex + 1} 项包含空字段名，无法生成 CSV 表头。`,
        );
      }
      if (!seenHeaders.has(header)) {
        const outputColumns = headers.length + 1;
        if (outputColumns * (value.length + 1) > MAX_CSV_JSON_CELLS) {
          return failureAt(
            input,
            0,
            "cell-limit",
            `转换结果超过 ${MAX_CSV_JSON_CELLS.toLocaleString("zh-CN")} 个单元格上限。`,
          );
        }
        seenHeaders.add(header);
        headers.push(header);
      }
    }
    rows.push(row);
  }

  if (headers.length === 0) {
    return failureAt(
      input,
      firstNonWhitespaceOffset(input),
      "empty-header",
      "JSON 对象没有字段，无法生成 CSV 表头。",
    );
  }

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    if (!row) continue;
    for (const header of headers) {
      if (!Object.hasOwn(row, header) || row[header] === null) continue;
      const cell = row[header];
      if (
        typeof cell !== "string" &&
        typeof cell !== "boolean" &&
        typeof cell !== "number"
      ) {
        return failureAt(
          input,
          0,
          "unsupported-structure",
          `JSON 第 ${rowIndex + 1} 项的“${header}”包含嵌套对象或数组；CSV 单元格只支持字符串、有限数字、布尔值和 null。`,
        );
      }
    }
  }

  const delimiter = options.delimiter ?? ",";
  const csv = renderJsonAsCsv(headers, rows, delimiter);
  if (csv === undefined) {
    return outputLimitFailure(input);
  }

  return {
    ok: true,
    value: csv,
    delimiter,
    rows: rows.length,
    columns: headers.length,
  };
}

export function transformCsvJson(
  input: string,
  direction: CsvJsonDirection,
  options: CsvJsonTransformOptions = {},
): CsvJsonTransformResult {
  return direction === "csv-to-json"
    ? csvToJson(input, options)
    : jsonToCsv(input, {
        delimiter:
          options.delimiter === "auto" ? "," : (options.delimiter ?? ","),
      });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function checkInputLimit(
  input: string,
): { ok: false; error: CsvJsonErrorDetails } | undefined {
  if (utf8ByteLength(input) <= MAX_CSV_JSON_INPUT_BYTES) {
    return undefined;
  }

  return resourceFailureAtStart(
    input,
    "input-limit",
    "输入超过 2 MiB 上限，请缩减内容后再试。",
  );
}

function outputLimitFailure(input: string): {
  ok: false;
  error: CsvJsonErrorDetails;
} {
  return resourceFailureAtStart(
    input,
    "output-limit",
    "转换结果超过 16 MiB 上限，请减少行数、列数或字段长度。",
  );
}

function stripLeadingBom(input: string): string {
  return input.startsWith("\uFEFF") ? input.slice(1) : input;
}

function detectDelimiter(
  input: string,
):
  | { ok: true; delimiter: CsvDelimiter; parsed: ParsedCsv }
  | { ok: false; error: CsvJsonErrorDetails } {
  const headerCandidates = delimitersInFirstRecord(input);
  let viableDelimiter: CsvDelimiter | undefined;
  let onlyCandidateError: { ok: false; error: CsvJsonErrorDetails } | undefined;

  for (const delimiter of headerCandidates) {
    const parsed = parseCsv(input, delimiter);
    if (!parsed.ok) {
      if (
        parsed.error.kind === "row-limit" ||
        parsed.error.kind === "cell-limit"
      ) {
        return parsed;
      }
      if (headerCandidates.length === 1) onlyCandidateError = parsed;
      continue;
    }
    if ((parsed.parsed.rows[0]?.length ?? 0) < 2) continue;
    if (headerCandidates.length === 1) {
      return { ok: true, delimiter, parsed: parsed.parsed };
    }
    if (viableDelimiter !== undefined) {
      return failureAt(
        input,
        input.startsWith("\uFEFF") ? 1 : 0,
        "delimiter-detection",
        "检测到多个可能的分隔符；为避免误拆列，请手动选择逗号、分号或制表符。",
      );
    }
    // Keep only the delimiter between attempts. Retaining the first complete
    // AST while parsing another candidate can double peak memory near limits.
    viableDelimiter = delimiter;
  }

  if (onlyCandidateError) return onlyCandidateError;

  if (viableDelimiter !== undefined) {
    const parsed = parseCsv(input, viableDelimiter);
    if (!parsed.ok) return parsed;
    return { ok: true, delimiter: viableDelimiter, parsed: parsed.parsed };
  }

  return failureAt(
    input,
    input.startsWith("\uFEFF") ? 1 : 0,
    "delimiter-detection",
    "无法安全识别 CSV 分隔符；请手动选择逗号、分号或制表符。",
  );
}

function delimitersInFirstRecord(input: string): CsvDelimiter[] {
  const counts = new Map<CsvDelimiter, number>(
    DELIMITER_CANDIDATES.map((delimiter) => [delimiter, 0]),
  );
  let quoted = false;
  let index = input.startsWith("\uFEFF") ? 1 : 0;

  while (index < input.length) {
    const character = input[index] ?? "";
    if (character === '"') {
      if (quoted && input[index + 1] === '"') {
        index += 2;
        continue;
      }
      quoted = !quoted;
      index += 1;
      continue;
    }
    if (!quoted && (character === "\r" || character === "\n")) break;
    if (!quoted && DELIMITER_CANDIDATES.includes(character as CsvDelimiter)) {
      const delimiter = character as CsvDelimiter;
      counts.set(delimiter, (counts.get(delimiter) ?? 0) + 1);
    }
    index += 1;
  }

  return DELIMITER_CANDIDATES.filter(
    (delimiter) => (counts.get(delimiter) ?? 0) > 0,
  );
}

class CsvParseLimitFailure extends Error {
  constructor(
    readonly kind: "row-limit" | "cell-limit",
    message: string,
    readonly offset: number,
  ) {
    super(message);
    this.name = "CsvParseLimitFailure";
  }
}

function parseCsv(input: string, delimiter: CsvDelimiter): ParseCsvResult {
  try {
    return parseCsvBounded(input, delimiter);
  } catch (error) {
    if (!(error instanceof CsvParseLimitFailure)) throw error;
    return failureAt(input, error.offset, error.kind, error.message);
  }
}

function parseCsvBounded(
  input: string,
  delimiter: CsvDelimiter,
): ParseCsvResult {
  const rows: string[][] = [];
  const fieldOffsets: number[][] = [];
  const rowOffsets: number[] = [];
  let cellCount = 0;
  let row: string[] = [];
  let offsets: number[] = [];
  let field = "";
  let index = input.startsWith("\uFEFF") ? 1 : 0;
  let fieldOffset = index;
  let rowOffset = index;
  let quoted = false;
  let quoteOffset = -1;
  let closedQuote = false;
  let endedWithRecordBreak = false;

  const pushField = () => {
    if (cellCount >= MAX_CSV_JSON_CELLS) {
      throw new CsvParseLimitFailure(
        "cell-limit",
        `CSV 超过 ${MAX_CSV_JSON_CELLS.toLocaleString("zh-CN")} 个单元格上限。`,
        fieldOffset,
      );
    }
    row.push(field);
    offsets.push(fieldOffset);
    cellCount += 1;
    field = "";
    closedQuote = false;
  };

  const pushRow = () => {
    if (rows.length >= MAX_CSV_JSON_ROWS) {
      throw new CsvParseLimitFailure(
        "row-limit",
        `CSV 超过 ${MAX_CSV_JSON_ROWS.toLocaleString("zh-CN")} 行上限。`,
        rowOffset,
      );
    }
    pushField();
    rows.push(row);
    fieldOffsets.push(offsets);
    rowOffsets.push(rowOffset);
    row = [];
    offsets = [];
  };

  while (index < input.length) {
    const character = input[index] ?? "";
    endedWithRecordBreak = false;

    if (quoted) {
      if (character === '"') {
        if (input[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        quoted = false;
        closedQuote = true;
        index += 1;
        continue;
      }

      field += character;
      index += 1;
      continue;
    }

    if (closedQuote) {
      if (character === delimiter) {
        pushField();
        index += 1;
        fieldOffset = index;
        continue;
      }

      if (character === "\r" || character === "\n") {
        pushRow();
        if (character === "\r" && input[index + 1] === "\n") index += 2;
        else index += 1;
        fieldOffset = index;
        rowOffset = index;
        endedWithRecordBreak = true;
        continue;
      }

      return failureAt(
        input,
        index,
        "syntax",
        "结束引号后只能出现分隔符或换行；请检查多余字符。",
      );
    }

    if (character === delimiter) {
      pushField();
      index += 1;
      fieldOffset = index;
      continue;
    }

    if (character === "\r" || character === "\n") {
      pushRow();
      if (character === "\r" && input[index + 1] === "\n") index += 2;
      else index += 1;
      fieldOffset = index;
      rowOffset = index;
      endedWithRecordBreak = true;
      continue;
    }

    if (character === '"') {
      if (field.length > 0) {
        return failureAt(
          input,
          index,
          "syntax",
          "引号字段必须从单元格开头开始；字段内的引号请写成两个连续引号。",
        );
      }
      quoted = true;
      quoteOffset = index;
      index += 1;
      continue;
    }

    field += character;
    index += 1;
  }

  if (quoted) {
    return failureAt(
      input,
      quoteOffset,
      "syntax",
      "带引号的 CSV 字段没有结束引号。",
    );
  }

  if (
    !endedWithRecordBreak ||
    row.length > 0 ||
    field.length > 0 ||
    closedQuote
  ) {
    pushRow();
  }

  return { ok: true, parsed: { rows, fieldOffsets, rowOffsets } };
}

function validateCsvShape(
  input: string,
  parsed: ParsedCsv,
):
  | { ok: true; value: ValidatedCsv }
  | { ok: false; error: CsvJsonErrorDetails } {
  const headers = parsed.rows[0];
  if (!headers) {
    return failureAt(input, 0, "syntax", "CSV 缺少表头行。");
  }

  for (let index = 0; index < headers.length; index += 1) {
    const header = headers[index] ?? "";
    if (!header.trim()) {
      return failureAt(
        input,
        parsed.fieldOffsets[0]?.[index] ?? parsed.rowOffsets[0] ?? 0,
        "empty-header",
        `第 ${index + 1} 列表头为空；请为每一列提供唯一名称。`,
      );
    }
  }

  const firstHeaderOffset = new Map<string, number>();
  for (let index = 0; index < headers.length; index += 1) {
    const header = headers[index] ?? "";
    if (firstHeaderOffset.has(header)) {
      return failureAt(
        input,
        parsed.fieldOffsets[0]?.[index] ?? 0,
        "duplicate-header",
        `表头“${header}”重复；JSON 对象字段名必须唯一。`,
      );
    }
    firstHeaderOffset.set(header, index);
  }

  for (let rowIndex = 1; rowIndex < parsed.rows.length; rowIndex += 1) {
    const row = parsed.rows[rowIndex];
    if (row && row.length !== headers.length) {
      return failureAt(
        input,
        parsed.rowOffsets[rowIndex] ?? 0,
        "column-mismatch",
        `第 ${rowIndex + 1} 行有 ${row.length} 列，但表头有 ${headers.length} 列。请补齐或删除多余单元格。`,
      );
    }
  }

  return {
    ok: true,
    value: { headers, dataRows: parsed.rows.slice(1) },
  };
}

function renderCsvAsJson(
  headers: string[],
  rows: string[][],
  indent: CsvJsonIndent,
): string | undefined {
  const writer = new BoundedCsvWriter(MAX_CSV_JSON_OUTPUT_BYTES);
  if (rows.length === 0)
    return writer.append("[]") ? writer.finish() : undefined;

  const rowIndent = " ".repeat(indent);
  const fieldIndent = " ".repeat(indent * 2);
  if (!writer.append("[\n")) return undefined;

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    if (!row) continue;
    if (rowIndex > 0 && !writer.append(",\n")) return undefined;
    if (!writer.append(`${rowIndent}{\n`)) return undefined;

    for (let columnIndex = 0; columnIndex < headers.length; columnIndex += 1) {
      const header = headers[columnIndex] ?? "";
      const cell = row[columnIndex] ?? "";
      if (columnIndex > 0 && !writer.append(",\n")) return undefined;
      if (!writer.append(fieldIndent)) return undefined;
      if (!writer.append(JSON.stringify(header))) return undefined;
      if (!writer.append(": ")) return undefined;
      if (!writer.append(JSON.stringify(cell))) return undefined;
    }

    if (!writer.append(`\n${rowIndent}}`)) return undefined;
  }

  if (!writer.append("\n]")) return undefined;
  return writer.finish();
}

function renderJsonAsCsv(
  headers: string[],
  rows: Array<Record<string, unknown>>,
  delimiter: CsvDelimiter,
): string | undefined {
  const writer = new BoundedCsvWriter(MAX_CSV_JSON_OUTPUT_BYTES);

  for (let columnIndex = 0; columnIndex < headers.length; columnIndex += 1) {
    const header = headers[columnIndex] ?? "";
    if (columnIndex > 0 && !writer.append(delimiter)) return undefined;
    if (!writer.append(escapeCsvCell(header, delimiter))) return undefined;
  }

  for (const row of rows) {
    if (!writer.append("\r\n")) return undefined;
    for (let columnIndex = 0; columnIndex < headers.length; columnIndex += 1) {
      const header = headers[columnIndex] ?? "";
      if (columnIndex > 0 && !writer.append(delimiter)) return undefined;

      let renderedCell = "";
      if (Object.hasOwn(row, header) && row[header] !== null) {
        const cell = row[header];
        renderedCell =
          typeof cell === "number" && Object.is(cell, -0) ? "-0" : String(cell);
      }

      if (!writer.append(escapeCsvCell(renderedCell, delimiter))) {
        return undefined;
      }
    }
  }

  return writer.finish();
}

class BoundedCsvWriter {
  private readonly chunks: string[] = [];
  private bytes = 0;

  constructor(private readonly maximumBytes: number) {}

  append(chunk: string): boolean {
    const chunkBytes = utf8ByteLength(chunk);
    if (this.bytes + chunkBytes > this.maximumBytes) return false;
    this.chunks.push(chunk);
    this.bytes += chunkBytes;
    return true;
  }

  finish(): string {
    return this.chunks.join("");
  }
}

function escapeCsvCell(value: string, delimiter: CsvDelimiter): string {
  if (
    value.includes(delimiter) ||
    value.includes('"') ||
    value.includes("\r") ||
    value.includes("\n")
  ) {
    return `"${value.replaceAll('"', '""')}"`;
  }
  return value;
}

class JsonSafetyScanner {
  private index = 0;
  private nodeCount = 0;

  constructor(private readonly source: string) {}

  inspect(): {
    offset: number;
    kind: CsvJsonErrorKind;
    message: string;
  } | null {
    try {
      this.skipWhitespace();
      this.scanValue(0);
      return null;
    } catch (error) {
      return error instanceof JsonSafetyFailure
        ? { offset: error.offset, kind: error.kind, message: error.message }
        : {
            offset: 0,
            kind: "syntax",
            message: "JSON 无法安全检查。",
          };
    }
  }

  private scanValue(depth: number): void {
    if (this.nodeCount >= MAX_CSV_JSON_NODES) {
      this.fail(
        "node-limit",
        `JSON 超过 ${MAX_CSV_JSON_NODES.toLocaleString("zh-CN")} 个语义节点上限。`,
      );
    }
    this.nodeCount += 1;

    if (depth > MAX_CSV_JSON_NESTING_DEPTH) {
      this.fail(
        "unsupported-structure",
        `JSON 嵌套超过 ${MAX_CSV_JSON_NESTING_DEPTH} 层，无法安全转换。`,
      );
    }

    const character = this.source[this.index] ?? "";
    if (character === '"') {
      this.scanString();
      return;
    }
    if (character === "{") {
      this.scanObject(depth + 1);
      return;
    }
    if (character === "[") {
      this.scanArray(depth + 1);
      return;
    }
    if (character === "t") {
      this.index += 4;
      return;
    }
    if (character === "f") {
      this.index += 5;
      return;
    }
    if (character === "n") {
      this.index += 4;
      return;
    }

    const token = this.source
      .slice(this.index)
      .match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u)?.[0];
    if (!token) return;

    if (token.length > MAX_CSV_JSON_NUMBER_CHARACTERS) {
      this.fail(
        "unsafe-number",
        `JSON 数字超过 ${MAX_CSV_JSON_NUMBER_CHARACTERS} 个字符的安全上限；请将它改为字符串。`,
      );
    }

    if (!jsonNumberPreservesValue(token)) {
      this.fail(
        "unsafe-number",
        "JSON 数字无法在转换中保持原值；请将它改为字符串，避免精度丢失。",
      );
    }
    this.index += token.length;
  }

  private scanObject(depth: number): void {
    this.index += 1;
    this.skipWhitespace();
    const keys = new Set<string>();
    if (this.source[this.index] === "}") {
      this.index += 1;
      return;
    }

    while (this.index < this.source.length) {
      const keyOffset = this.index;
      const rawKey = this.scanString();
      const key = JSON.parse(rawKey) as string;
      if (keys.has(key)) {
        throw new JsonSafetyFailure(
          "duplicate-header",
          `JSON 对象字段“${key}”重复；重复字段会造成数据丢失。`,
          keyOffset,
        );
      }
      keys.add(key);
      this.skipWhitespace();
      this.index += 1;
      this.skipWhitespace();
      this.scanValue(depth);
      this.skipWhitespace();
      if (this.source[this.index] === "}") {
        this.index += 1;
        return;
      }
      this.index += 1;
      this.skipWhitespace();
    }
  }

  private scanArray(depth: number): void {
    this.index += 1;
    this.skipWhitespace();
    if (this.source[this.index] === "]") {
      this.index += 1;
      return;
    }

    while (this.index < this.source.length) {
      this.scanValue(depth);
      this.skipWhitespace();
      if (this.source[this.index] === "]") {
        this.index += 1;
        return;
      }
      this.index += 1;
      this.skipWhitespace();
    }
  }

  private scanString(): string {
    const start = this.index;
    this.index += 1;
    while (this.index < this.source.length) {
      const character = this.source[this.index] ?? "";
      if (character === "\\") {
        this.index += 2;
      } else if (character === '"') {
        this.index += 1;
        return this.source.slice(start, this.index);
      } else {
        this.index += 1;
      }
    }
    return this.source.slice(start, this.index);
  }

  private skipWhitespace(): void {
    while (/\s/u.test(this.source[this.index] ?? "")) this.index += 1;
  }

  private fail(kind: CsvJsonErrorKind, message: string): never {
    throw new JsonSafetyFailure(kind, message, this.index);
  }
}

class JsonSafetyFailure extends Error {
  constructor(
    readonly kind: CsvJsonErrorKind,
    message: string,
    readonly offset: number,
  ) {
    super(message);
    this.name = "JsonSafetyFailure";
  }
}

function inspectJsonSafety(
  input: string,
): { ok: false; error: CsvJsonErrorDetails } | undefined {
  const issue = new JsonSafetyScanner(input).inspect();
  return issue
    ? failureAt(input, issue.offset, issue.kind, issue.message)
    : undefined;
}

type DecimalValue = {
  negative: boolean;
  digits: string;
  exponent: bigint;
};

function jsonNumberPreservesValue(token: string): boolean {
  const numberValue = Number(token);
  if (!Number.isFinite(numberValue)) return false;

  const source = parseDecimalValue(token);
  const rendered = parseDecimalValue(
    Object.is(numberValue, -0) ? "-0" : String(numberValue),
  );
  if (!source || !rendered || !sameDecimalValue(source, rendered)) return false;

  if (source.exponent >= 0n && source.exponent <= 400n) {
    const magnitude = BigInt(
      `${source.digits}${"0".repeat(Number(source.exponent))}`,
    );
    const exact = source.negative ? -magnitude : magnitude;
    if (!Number.isInteger(numberValue) || BigInt(numberValue) !== exact) {
      return false;
    }
  }

  return true;
}

function parseDecimalValue(token: string): DecimalValue | null {
  const match = token.match(/^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/u);
  if (!match) return null;

  const fraction = match[3] ?? "";
  let digits = `${match[2] ?? ""}${fraction}`.replace(/^0+/u, "");
  if (!digits) return { negative: match[1] === "-", digits: "0", exponent: 0n };

  const exponentText =
    (match[4] ?? "0").replace(/^[+-]/u, "").replace(/^0+/u, "") || "0";
  if (exponentText.length > 20) return null;
  let exponent = BigInt(exponentText);
  if ((match[4] ?? "").startsWith("-")) exponent = -exponent;

  const trailingZeros = digits.length - digits.replace(/0+$/u, "").length;
  if (trailingZeros > 0) digits = digits.slice(0, -trailingZeros);

  return {
    negative: match[1] === "-",
    digits,
    exponent: exponent - BigInt(fraction.length) + BigInt(trailingZeros),
  };
}

function sameDecimalValue(left: DecimalValue, right: DecimalValue): boolean {
  if (left.digits === "0" && right.digits === "0") return true;
  return (
    left.negative === right.negative &&
    left.digits === right.digits &&
    left.exponent === right.exponent
  );
}

function firstNonWhitespaceOffset(input: string): number {
  const offset = input.search(/\S/u);
  return offset < 0 ? 0 : offset;
}

function resourceFailureAtStart(
  source: string,
  kind: CsvJsonErrorKind,
  message: string,
): { ok: false; error: CsvJsonErrorDetails } {
  const context = Array.from(source.slice(0, 160)).slice(0, 80).join("");
  return {
    ok: false,
    error: {
      kind,
      offset: 0,
      line: 1,
      column: 1,
      message,
      context,
      pointer: "^",
    },
  };
}

function failureAt(
  source: string,
  requestedOffset: number,
  kind: CsvJsonErrorKind,
  message: string,
): { ok: false; error: CsvJsonErrorDetails } {
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

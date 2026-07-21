export type JsonIndent = 2 | 4 | "tab";

export const MAX_JSON_INPUT_BYTES = 2 * 1024 * 1024;
export const MAX_JSON_NESTING_DEPTH = 100;
export const MAX_JSON_NODES = 100_000;
export const MAX_JSON_OUTPUT_BYTES = 16 * 1024 * 1024;

export interface JsonErrorDetails {
  /** Zero-based UTF-16 offset, suitable for textarea selection APIs. */
  offset: number;
  /** One-based line number. */
  line: number;
  /** One-based, Unicode code-point-aware column number. */
  column: number;
  message: string;
  /** A short excerpt from the line containing the error. */
  context: string;
  /** A caret aligned with the error inside `context`. */
  pointer: string;
}

export type JsonTransformResult =
  { ok: true; value: string } | { ok: false; error: JsonErrorDetails };

export type JsonValidationResult =
  { ok: true } | { ok: false; error: JsonErrorDetails };

type JsonNode =
  | { kind: "primitive"; raw: string }
  | { kind: "array"; items: JsonNode[] }
  | { kind: "object"; entries: Array<{ key: string; value: JsonNode }> };

class JsonParseFailure extends Error {
  readonly offset: number;

  constructor(message: string, offset: number) {
    super(message);
    this.name = "JsonParseFailure";
    this.offset = offset;
  }
}

class JsonParser {
  private index = 0;
  private nodeCount = 0;

  constructor(private readonly source: string) {}

  parse(): JsonNode {
    this.skipWhitespace();

    if (this.atEnd()) {
      this.fail("JSON input is empty.");
    }

    const value = this.parseValue(0);
    this.skipWhitespace();

    if (!this.atEnd()) {
      this.fail("Unexpected content after the JSON value.");
    }

    return value;
  }

  private parseValue(depth: number): JsonNode {
    this.reserveNode();
    const character = this.peek();

    if (character === '"') {
      return { kind: "primitive", raw: this.parseString() };
    }

    if (character === "{") {
      this.assertContainerDepth(depth);
      return this.parseObject(depth + 1);
    }

    if (character === "[") {
      this.assertContainerDepth(depth);
      return this.parseArray(depth + 1);
    }

    if (character === "t") {
      return this.parseLiteral("true");
    }

    if (character === "f") {
      return this.parseLiteral("false");
    }

    if (character === "n") {
      return this.parseLiteral("null");
    }

    if (character === "-" || isDigit(character)) {
      return this.parseNumber();
    }

    this.fail(
      this.atEnd()
        ? "Expected a JSON value."
        : `Unexpected token ${describeCharacter(character)}; expected a JSON value.`,
    );
  }

  private parseObject(childDepth: number): JsonNode {
    this.index += 1;
    const entries: Array<{ key: string; value: JsonNode }> = [];
    this.skipWhitespace();

    if (this.consumeIf("}")) {
      return { kind: "object", entries };
    }

    while (true) {
      if (this.peek() !== '"') {
        this.fail("Expected a double-quoted object key.");
      }

      const key = this.parseString();
      this.skipWhitespace();
      this.expect(":", "Expected ':' after the object key.");
      this.skipWhitespace();
      const value = this.parseValue(childDepth);
      entries.push({ key, value });
      this.skipWhitespace();

      if (this.consumeIf("}")) {
        return { kind: "object", entries };
      }

      this.expect(",", "Expected ',' or '}' after the object value.");
      this.skipWhitespace();
    }
  }

  private parseArray(childDepth: number): JsonNode {
    this.index += 1;
    const items: JsonNode[] = [];
    this.skipWhitespace();

    if (this.consumeIf("]")) {
      return { kind: "array", items };
    }

    while (true) {
      const item = this.parseValue(childDepth);
      items.push(item);
      this.skipWhitespace();

      if (this.consumeIf("]")) {
        return { kind: "array", items };
      }

      this.expect(",", "Expected ',' or ']' after the array item.");
      this.skipWhitespace();
    }
  }

  private parseString(): string {
    const start = this.index;
    this.index += 1;

    while (!this.atEnd()) {
      const character = this.peek();

      if (character === '"') {
        this.index += 1;
        return this.source.slice(start, this.index);
      }

      if (character === "\\") {
        this.index += 1;

        if (this.atEnd()) {
          this.fail("Unterminated escape sequence in string.");
        }

        const escaped = this.peek();
        if ('"\\/bfnrt'.includes(escaped)) {
          this.index += 1;
          continue;
        }

        if (escaped !== "u") {
          this.fail(`Invalid escape sequence '\\${escaped}'.`);
        }

        this.index += 1;
        for (let digitIndex = 0; digitIndex < 4; digitIndex += 1) {
          if (!isHexDigit(this.peek())) {
            this.fail(
              "A Unicode escape must contain exactly four hexadecimal digits.",
            );
          }
          this.index += 1;
        }
        continue;
      }

      if (character.charCodeAt(0) < 0x20) {
        this.fail("Unescaped control character in string.");
      }

      this.index += 1;
    }

    this.fail("Unterminated string.");
  }

  private parseNumber(): JsonNode {
    const start = this.index;

    if (this.consumeIf("-")) {
      if (!isDigit(this.peek())) {
        this.fail("Expected a digit after '-'.");
      }
    }

    if (this.consumeIf("0")) {
      if (isDigit(this.peek())) {
        this.fail("Leading zeros are not allowed in JSON numbers.");
      }
    } else {
      if (!isOneToNine(this.peek())) {
        this.fail("Expected a digit in the JSON number.");
      }

      while (isDigit(this.peek())) {
        this.index += 1;
      }
    }

    if (this.consumeIf(".")) {
      if (!isDigit(this.peek())) {
        this.fail("Expected at least one digit after the decimal point.");
      }

      while (isDigit(this.peek())) {
        this.index += 1;
      }
    }

    if (this.peek() === "e" || this.peek() === "E") {
      this.index += 1;

      if (this.peek() === "+" || this.peek() === "-") {
        this.index += 1;
      }

      if (!isDigit(this.peek())) {
        this.fail("Expected at least one digit in the exponent.");
      }

      while (isDigit(this.peek())) {
        this.index += 1;
      }
    }

    return { kind: "primitive", raw: this.source.slice(start, this.index) };
  }

  private parseLiteral(literal: "true" | "false" | "null"): JsonNode {
    const start = this.index;

    for (const expected of literal) {
      if (this.peek() !== expected) {
        this.fail(`Invalid literal; expected '${literal}'.`);
      }
      this.index += 1;
    }

    return { kind: "primitive", raw: this.source.slice(start, this.index) };
  }

  private skipWhitespace(): void {
    while (
      this.peek() === " " ||
      this.peek() === "\t" ||
      this.peek() === "\n" ||
      this.peek() === "\r"
    ) {
      this.index += 1;
    }
  }

  private expect(expected: string, message: string): void {
    if (!this.consumeIf(expected)) {
      this.fail(message);
    }
  }

  private consumeIf(expected: string): boolean {
    if (this.peek() !== expected) {
      return false;
    }

    this.index += 1;
    return true;
  }

  private peek(): string {
    return this.source[this.index] ?? "";
  }

  private atEnd(): boolean {
    return this.index >= this.source.length;
  }

  private reserveNode(): void {
    if (this.nodeCount >= MAX_JSON_NODES) {
      this.fail(
        `JSON contains more than ${MAX_JSON_NODES.toLocaleString("en-US")} values and containers.`,
      );
    }
    this.nodeCount += 1;
  }

  private assertContainerDepth(depth: number): void {
    if (depth >= MAX_JSON_NESTING_DEPTH) {
      this.fail(
        `JSON nesting exceeds the ${MAX_JSON_NESTING_DEPTH}-level limit.`,
      );
    }
  }

  private fail(message: string, offset = this.index): never {
    throw new JsonParseFailure(message, offset);
  }
}

/**
 * Pretty-prints strict JSON without converting numeric tokens to JavaScript
 * numbers. This preserves integers larger than `Number.MAX_SAFE_INTEGER`, as
 * well as exponent spelling and trailing fractional zeros.
 */
export function formatJson(
  input: string,
  indent: JsonIndent = 2,
): JsonTransformResult {
  return transformJson(input, indentationUnit(indent));
}

/** Removes insignificant JSON whitespace while preserving primitive lexemes. */
export function minifyJson(input: string): JsonTransformResult {
  return transformJson(input, "");
}

/** Validates strict JSON and returns a structured, UI-ready error on failure. */
export function validateJson(input: string): JsonValidationResult {
  const parsed = parseJson(input);
  return parsed.ok ? { ok: true } : parsed;
}

function transformJson(input: string, indent: string): JsonTransformResult {
  const parsed = parseJson(input);

  if (!parsed.ok) {
    return parsed;
  }

  const writer = new BoundedJsonWriter(MAX_JSON_OUTPUT_BYTES);

  try {
    renderNode(parsed.value, indent, writer);
    return { ok: true, value: writer.finish() };
  } catch (error) {
    if (!(error instanceof JsonOutputFailure)) {
      throw error;
    }

    return {
      ok: false,
      error: describeResourceError(
        input,
        `Formatted JSON exceeds the ${formatMebibytes(MAX_JSON_OUTPUT_BYTES)} MiB output limit.`,
      ),
    };
  }
}

function parseJson(
  input: string,
): { ok: true; value: JsonNode } | { ok: false; error: JsonErrorDetails } {
  if (utf8ByteLength(input) > MAX_JSON_INPUT_BYTES) {
    return {
      ok: false,
      error: describeResourceError(
        input,
        `JSON input exceeds the ${formatMebibytes(MAX_JSON_INPUT_BYTES)} MiB limit.`,
      ),
    };
  }

  try {
    return { ok: true, value: new JsonParser(input).parse() };
  } catch (error) {
    if (!(error instanceof JsonParseFailure)) {
      throw error;
    }

    return { ok: false, error: describeError(input, error) };
  }
}

function renderNode(
  node: JsonNode,
  indent: string,
  writer: BoundedJsonWriter,
  depth = 0,
): void {
  if (node.kind === "primitive") {
    writer.append(node.raw);
    return;
  }

  if (node.kind === "array") {
    if (node.items.length === 0) {
      writer.append("[]");
      return;
    }

    if (indent === "") {
      writer.append("[");
      for (let index = 0; index < node.items.length; index += 1) {
        if (index > 0) writer.append(",");
        const item = node.items[index];
        if (item) renderNode(item, indent, writer);
      }
      writer.append("]");
      return;
    }

    const currentIndent = indent.repeat(depth);
    const childIndent = indent.repeat(depth + 1);
    writer.append("[\n");
    for (let index = 0; index < node.items.length; index += 1) {
      if (index > 0) writer.append(",\n");
      writer.append(childIndent);
      const item = node.items[index];
      if (item) renderNode(item, indent, writer, depth + 1);
    }
    writer.append(`\n${currentIndent}]`);
    return;
  }

  if (node.entries.length === 0) {
    writer.append("{}");
    return;
  }

  if (indent === "") {
    writer.append("{");
    for (let index = 0; index < node.entries.length; index += 1) {
      if (index > 0) writer.append(",");
      const entry = node.entries[index];
      if (!entry) continue;
      writer.append(entry.key);
      writer.append(":");
      renderNode(entry.value, indent, writer);
    }
    writer.append("}");
    return;
  }

  const currentIndent = indent.repeat(depth);
  const childIndent = indent.repeat(depth + 1);
  writer.append("{\n");
  for (let index = 0; index < node.entries.length; index += 1) {
    if (index > 0) writer.append(",\n");
    const entry = node.entries[index];
    if (!entry) continue;
    writer.append(childIndent);
    writer.append(entry.key);
    writer.append(": ");
    renderNode(entry.value, indent, writer, depth + 1);
  }
  writer.append(`\n${currentIndent}}`);
}

class JsonOutputFailure extends Error {
  constructor() {
    super("JSON output limit exceeded.");
    this.name = "JsonOutputFailure";
  }
}

class BoundedJsonWriter {
  private readonly chunks: string[] = [];
  private bytes = 0;

  constructor(private readonly maximumBytes: number) {}

  append(chunk: string): void {
    const chunkBytes = utf8ByteLength(chunk);
    if (this.bytes + chunkBytes > this.maximumBytes) {
      throw new JsonOutputFailure();
    }

    this.chunks.push(chunk);
    this.bytes += chunkBytes;
  }

  finish(): string {
    return this.chunks.join("");
  }
}

function indentationUnit(indent: JsonIndent): string {
  if (indent === "tab") {
    return "\t";
  }

  return " ".repeat(indent);
}

function describeError(
  source: string,
  failure: JsonParseFailure,
): JsonErrorDetails {
  const location = locateOffset(source, failure.offset);
  const excerpt = lineExcerpt(source, failure.offset);

  return {
    offset: failure.offset,
    line: location.line,
    column: location.column,
    message: failure.message,
    context: excerpt.context,
    pointer: `${" ".repeat(excerpt.pointerColumn)}^`,
  };
}

function describeResourceError(
  source: string,
  message: string,
): JsonErrorDetails {
  return {
    offset: 0,
    line: 1,
    column: 1,
    message,
    context: Array.from(source.slice(0, 160)).slice(0, 80).join(""),
    pointer: "^",
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
      if (source[index + 1] === "\n") {
        index += 1;
      }
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

function describeCharacter(character: string): string {
  return character === "" ? "end of input" : JSON.stringify(character);
}

function isDigit(character: string): boolean {
  return character >= "0" && character <= "9";
}

function isOneToNine(character: string): boolean {
  return character >= "1" && character <= "9";
}

function isHexDigit(character: string): boolean {
  return (
    isDigit(character) ||
    (character >= "a" && character <= "f") ||
    (character >= "A" && character <= "F")
  );
}

function formatMebibytes(bytes: number): number {
  return bytes / (1024 * 1024);
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

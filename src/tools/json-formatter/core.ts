export type JsonIndent = 2 | 4 | "tab";

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

  constructor(private readonly source: string) {}

  parse(): JsonNode {
    this.skipWhitespace();

    if (this.atEnd()) {
      this.fail("JSON input is empty.");
    }

    const value = this.parseValue();
    this.skipWhitespace();

    if (!this.atEnd()) {
      this.fail("Unexpected content after the JSON value.");
    }

    return value;
  }

  private parseValue(): JsonNode {
    const character = this.peek();

    if (character === '"') {
      return { kind: "primitive", raw: this.parseString() };
    }

    if (character === "{") {
      return this.parseObject();
    }

    if (character === "[") {
      return this.parseArray();
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

  private parseObject(): JsonNode {
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
      const value = this.parseValue();
      entries.push({ key, value });
      this.skipWhitespace();

      if (this.consumeIf("}")) {
        return { kind: "object", entries };
      }

      this.expect(",", "Expected ',' or '}' after the object value.");
      this.skipWhitespace();
    }
  }

  private parseArray(): JsonNode {
    this.index += 1;
    const items: JsonNode[] = [];
    this.skipWhitespace();

    if (this.consumeIf("]")) {
      return { kind: "array", items };
    }

    while (true) {
      items.push(this.parseValue());
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

  return { ok: true, value: renderNode(parsed.value, indent) };
}

function parseJson(
  input: string,
): { ok: true; value: JsonNode } | { ok: false; error: JsonErrorDetails } {
  try {
    return { ok: true, value: new JsonParser(input).parse() };
  } catch (error) {
    if (!(error instanceof JsonParseFailure)) {
      throw error;
    }

    return { ok: false, error: describeError(input, error) };
  }
}

function renderNode(node: JsonNode, indent: string, depth = 0): string {
  if (node.kind === "primitive") {
    return node.raw;
  }

  if (node.kind === "array") {
    if (node.items.length === 0) {
      return "[]";
    }

    if (indent === "") {
      return `[${node.items.map((item) => renderNode(item, indent)).join(",")}]`;
    }

    const currentIndent = indent.repeat(depth);
    const childIndent = indent.repeat(depth + 1);
    const items = node.items
      .map((item) => `${childIndent}${renderNode(item, indent, depth + 1)}`)
      .join(",\n");
    return `[\n${items}\n${currentIndent}]`;
  }

  if (node.entries.length === 0) {
    return "{}";
  }

  if (indent === "") {
    const entries = node.entries
      .map(({ key, value }) => `${key}:${renderNode(value, indent)}`)
      .join(",");
    return `{${entries}}`;
  }

  const currentIndent = indent.repeat(depth);
  const childIndent = indent.repeat(depth + 1);
  const entries = node.entries
    .map(
      ({ key, value }) =>
        `${childIndent}${key}: ${renderNode(value, indent, depth + 1)}`,
    )
    .join(",\n");
  return `{\n${entries}\n${currentIndent}}`;
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

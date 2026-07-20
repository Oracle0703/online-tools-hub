export interface TextDiffLimits {
  maxBytesPerInput: number;
  maxLinesPerInput: number;
  maxTraceCells: number;
}

export const TEXT_DIFF_LIMITS: Readonly<TextDiffLimits> = {
  maxBytesPerInput: 512 * 1024,
  maxLinesPerInput: 5_000,
  /** Bounds both frontier work and the stored reconstruction trace. */
  maxTraceCells: 2_000_000,
} as const;

export type TextDiffSide = "original" | "revised";
export type TextDiffEntryType = "equal" | "added" | "removed";

export interface TextDiffOptions {
  ignoreWhitespace?: boolean;
  ignoreCase?: boolean;
  /** Primarily useful to enforce a stricter budget in an embedding UI or test. */
  limits?: Partial<TextDiffLimits>;
}

export interface TextDiffCell {
  lineNumber: number;
  text: string;
}

export interface TextDiffEntry {
  type: TextDiffEntryType;
  original: TextDiffCell | null;
  revised: TextDiffCell | null;
}

export type SideBySideRowType = TextDiffEntryType | "changed";

export interface SideBySideRow {
  type: SideBySideRowType;
  original: TextDiffCell | null;
  revised: TextDiffCell | null;
}

export interface TextDiffStats {
  originalLines: number;
  revisedLines: number;
  added: number;
  removed: number;
  unchanged: number;
  changedBlocks: number;
}

export interface TextDiffSuccess {
  ok: true;
  entries: TextDiffEntry[];
  sideBySide: SideBySideRow[];
  unified: string;
  stats: TextDiffStats;
}

export type TextDiffErrorCode =
  "input-too-large" | "too-many-lines" | "comparison-too-complex";

export interface TextDiffErrorDetails {
  code: TextDiffErrorCode;
  message: string;
  side?: TextDiffSide;
  actual?: number;
  limit?: number;
}

export interface TextDiffFailure {
  ok: false;
  error: TextDiffErrorDetails;
}

export type TextDiffResult = TextDiffSuccess | TextDiffFailure;

type PrimitiveEdit =
  | { type: "equal"; originalIndex: number; revisedIndex: number }
  | { type: "removed"; originalIndex: number }
  | { type: "added"; revisedIndex: number };

type NormalizedLimits = {
  maxBytesPerInput: number;
  maxLinesPerInput: number;
  maxTraceCells: number;
};

type TraceSlice = {
  values: Int32Array;
  offset: number;
};

function normalizePositiveLimit(value: number | undefined, fallback: number) {
  return Number.isSafeInteger(value) && (value ?? 0) > 0
    ? Math.min(value as number, fallback)
    : fallback;
}

function normalizeLimits(
  overrides: TextDiffOptions["limits"],
): NormalizedLimits {
  return {
    maxBytesPerInput: normalizePositiveLimit(
      overrides?.maxBytesPerInput,
      TEXT_DIFF_LIMITS.maxBytesPerInput,
    ),
    maxLinesPerInput: normalizePositiveLimit(
      overrides?.maxLinesPerInput,
      TEXT_DIFF_LIMITS.maxLinesPerInput,
    ),
    maxTraceCells: normalizePositiveLimit(
      overrides?.maxTraceCells,
      TEXT_DIFF_LIMITS.maxTraceCells,
    ),
  };
}

export function getTextByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/** CRLF and classic-Mac CR are treated as line endings equivalent to LF. */
export function splitTextLines(value: string): string[] {
  if (value.length === 0) return [];
  return value.replace(/\r\n?/gu, "\n").split("\n");
}

export function countTextLines(value: string): number {
  return splitTextLines(value).length;
}

function comparisonKey(line: string, options: TextDiffOptions): string {
  let key = options.ignoreWhitespace ? line.replace(/\s/gu, "") : line;
  if (options.ignoreCase) key = key.toLocaleLowerCase("und");
  return key;
}

function validateInput(
  text: string,
  lines: readonly string[],
  side: TextDiffSide,
  limits: NormalizedLimits,
): TextDiffErrorDetails | null {
  const bytes = getTextByteLength(text);
  if (bytes > limits.maxBytesPerInput) {
    return {
      code: "input-too-large",
      side,
      actual: bytes,
      limit: limits.maxBytesPerInput,
      message: `${side === "original" ? "原文" : "新文本"}为 ${bytes.toLocaleString("en-US")} 字节，超过每侧 ${limits.maxBytesPerInput.toLocaleString("en-US")} 字节上限。`,
    };
  }

  if (lines.length > limits.maxLinesPerInput) {
    return {
      code: "too-many-lines",
      side,
      actual: lines.length,
      limit: limits.maxLinesPerInput,
      message: `${side === "original" ? "原文" : "新文本"}有 ${lines.length.toLocaleString("en-US")} 行，超过每侧 ${limits.maxLinesPerInput.toLocaleString("en-US")} 行上限。`,
    };
  }

  return null;
}

function hasSharedKey(left: readonly string[], right: readonly string[]) {
  const [smaller, larger] =
    left.length <= right.length ? [left, right] : [right, left];
  const keys = new Set(smaller);
  return larger.some((key) => keys.has(key));
}

function readTrace(slice: TraceSlice, diagonal: number): number {
  const index = diagonal + slice.offset;
  return index >= 0 && index < slice.values.length
    ? (slice.values[index] ?? -1)
    : -1;
}

function backtrackMyers(
  trace: readonly TraceSlice[],
  original: readonly string[],
  revised: readonly string[],
): PrimitiveEdit[] {
  let x = original.length;
  let y = revised.length;
  const reversed: PrimitiveEdit[] = [];

  for (let distance = trace.length - 1; distance >= 0; distance -= 1) {
    const snapshot = trace[distance];
    if (!snapshot) break;

    const diagonal = x - y;
    const previousDiagonal =
      diagonal === -distance ||
      (diagonal !== distance &&
        readTrace(snapshot, diagonal - 1) < readTrace(snapshot, diagonal + 1))
        ? diagonal + 1
        : diagonal - 1;
    const previousX = Math.max(0, readTrace(snapshot, previousDiagonal));
    const previousY = previousX - previousDiagonal;

    while (x > previousX && y > previousY) {
      reversed.push({
        type: "equal",
        originalIndex: x - 1,
        revisedIndex: y - 1,
      });
      x -= 1;
      y -= 1;
    }

    if (distance === 0) break;

    if (x === previousX) {
      y -= 1;
      reversed.push({ type: "added", revisedIndex: y });
    } else {
      x -= 1;
      reversed.push({ type: "removed", originalIndex: x });
    }
  }

  return reversed.reverse();
}

/**
 * Myers shortest-edit-path search with a hard reconstruction-memory budget.
 * The live frontier is O(N + M); stored trace cells never exceed maxTraceCells.
 */
function boundedMyers(
  original: readonly string[],
  revised: readonly string[],
  maxTraceCells: number,
): PrimitiveEdit[] | null {
  const maximumDistance = original.length + revised.length;
  const frontier = new Int32Array(2 * maximumDistance + 3);
  frontier.fill(-1);
  const frontierOffset = maximumDistance + 1;
  frontier[frontierOffset + 1] = 0;

  const trace: TraceSlice[] = [];
  let storedCells = 0;

  const readFrontier = (diagonal: number) =>
    frontier[frontierOffset + diagonal] ?? -1;

  for (let distance = 0; distance <= maximumDistance; distance += 1) {
    const snapshotLength = 2 * distance + 3;
    if (storedCells + snapshotLength > maxTraceCells) return null;

    const values = new Int32Array(snapshotLength);
    values.fill(-1);
    const offset = distance + 1;
    for (
      let diagonal = -distance - 1;
      diagonal <= distance + 1;
      diagonal += 1
    ) {
      values[diagonal + offset] = readFrontier(diagonal);
    }
    trace.push({ values, offset });
    storedCells += snapshotLength;

    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      let x =
        diagonal === -distance ||
        (diagonal !== distance &&
          readFrontier(diagonal - 1) < readFrontier(diagonal + 1))
          ? readFrontier(diagonal + 1)
          : readFrontier(diagonal - 1) + 1;
      let y = x - diagonal;

      while (
        x < original.length &&
        y < revised.length &&
        original[x] === revised[y]
      ) {
        x += 1;
        y += 1;
      }

      frontier[frontierOffset + diagonal] = x;
      if (x >= original.length && y >= revised.length) {
        return backtrackMyers(trace, original, revised);
      }
    }
  }

  return null;
}

function createPrimitiveDiff(
  originalKeys: readonly string[],
  revisedKeys: readonly string[],
  maxTraceCells: number,
): PrimitiveEdit[] | null {
  let prefixLength = 0;
  const shorterLength = Math.min(originalKeys.length, revisedKeys.length);
  while (
    prefixLength < shorterLength &&
    originalKeys[prefixLength] === revisedKeys[prefixLength]
  ) {
    prefixLength += 1;
  }

  let suffixLength = 0;
  while (
    suffixLength < shorterLength - prefixLength &&
    originalKeys[originalKeys.length - suffixLength - 1] ===
      revisedKeys[revisedKeys.length - suffixLength - 1]
  ) {
    suffixLength += 1;
  }

  const originalMiddleEnd = originalKeys.length - suffixLength;
  const revisedMiddleEnd = revisedKeys.length - suffixLength;
  const originalMiddle = originalKeys.slice(prefixLength, originalMiddleEnd);
  const revisedMiddle = revisedKeys.slice(prefixLength, revisedMiddleEnd);

  const prefix: PrimitiveEdit[] = Array.from(
    { length: prefixLength },
    (_, index) => ({
      type: "equal" as const,
      originalIndex: index,
      revisedIndex: index,
    }),
  );

  let middle: PrimitiveEdit[] | null;
  if (originalMiddle.length === 0) {
    middle = revisedMiddle.map((_, revisedIndex) => ({
      type: "added" as const,
      revisedIndex,
    }));
  } else if (revisedMiddle.length === 0) {
    middle = originalMiddle.map((_, originalIndex) => ({
      type: "removed" as const,
      originalIndex,
    }));
  } else if (!hasSharedKey(originalMiddle, revisedMiddle)) {
    middle = [
      ...originalMiddle.map((_, originalIndex) => ({
        type: "removed" as const,
        originalIndex,
      })),
      ...revisedMiddle.map((_, revisedIndex) => ({
        type: "added" as const,
        revisedIndex,
      })),
    ];
  } else {
    middle = boundedMyers(originalMiddle, revisedMiddle, maxTraceCells);
  }

  if (!middle) return null;

  const shiftedMiddle = middle.map((edit): PrimitiveEdit => {
    if (edit.type === "equal") {
      return {
        type: "equal",
        originalIndex: edit.originalIndex + prefixLength,
        revisedIndex: edit.revisedIndex + prefixLength,
      };
    }
    return edit.type === "removed"
      ? {
          type: "removed",
          originalIndex: edit.originalIndex + prefixLength,
        }
      : { type: "added", revisedIndex: edit.revisedIndex + prefixLength };
  });

  const suffix: PrimitiveEdit[] = Array.from(
    { length: suffixLength },
    (_, index) => ({
      type: "equal" as const,
      originalIndex: originalMiddleEnd + index,
      revisedIndex: revisedMiddleEnd + index,
    }),
  );

  return [...prefix, ...shiftedMiddle, ...suffix];
}

function createEntries(
  edits: readonly PrimitiveEdit[],
  originalLines: readonly string[],
  revisedLines: readonly string[],
): TextDiffEntry[] {
  return edits.map((edit) => {
    if (edit.type === "equal") {
      return {
        type: "equal",
        original: {
          lineNumber: edit.originalIndex + 1,
          text: originalLines[edit.originalIndex] ?? "",
        },
        revised: {
          lineNumber: edit.revisedIndex + 1,
          text: revisedLines[edit.revisedIndex] ?? "",
        },
      };
    }

    if (edit.type === "removed") {
      return {
        type: "removed",
        original: {
          lineNumber: edit.originalIndex + 1,
          text: originalLines[edit.originalIndex] ?? "",
        },
        revised: null,
      };
    }

    return {
      type: "added",
      original: null,
      revised: {
        lineNumber: edit.revisedIndex + 1,
        text: revisedLines[edit.revisedIndex] ?? "",
      },
    };
  });
}

export function createSideBySideRows(
  entries: readonly TextDiffEntry[],
): SideBySideRow[] {
  const rows: SideBySideRow[] = [];

  for (let index = 0; index < entries.length;) {
    const entry = entries[index];
    if (!entry) break;

    if (entry.type === "equal") {
      rows.push({
        type: "equal",
        original: entry.original,
        revised: entry.revised,
      });
      index += 1;
      continue;
    }

    const removed: TextDiffCell[] = [];
    const added: TextDiffCell[] = [];
    while (index < entries.length && entries[index]?.type !== "equal") {
      const changedEntry = entries[index];
      if (changedEntry?.type === "removed" && changedEntry.original) {
        removed.push(changedEntry.original);
      } else if (changedEntry?.type === "added" && changedEntry.revised) {
        added.push(changedEntry.revised);
      }
      index += 1;
    }

    const blockLength = Math.max(removed.length, added.length);
    for (let rowIndex = 0; rowIndex < blockLength; rowIndex += 1) {
      const original = removed[rowIndex] ?? null;
      const revised = added[rowIndex] ?? null;
      rows.push({
        type: original && revised ? "changed" : original ? "removed" : "added",
        original,
        revised,
      });
    }
  }

  return rows;
}

export function createUnifiedDiff(
  entries: readonly TextDiffEntry[],
  originalLineCount: number,
  revisedLineCount: number,
): string {
  const header = [
    "--- 原文",
    "+++ 新文本",
    `@@ -1,${originalLineCount} +1,${revisedLineCount} @@`,
  ];
  const body = entries.map((entry) => {
    if (entry.type === "removed") return `-${entry.original?.text ?? ""}`;
    if (entry.type === "added") return `+${entry.revised?.text ?? ""}`;
    return ` ${entry.revised?.text ?? entry.original?.text ?? ""}`;
  });
  return [...header, ...body].join("\n");
}

function countChangedBlocks(entries: readonly TextDiffEntry[]): number {
  let blocks = 0;
  let insideChange = false;
  for (const entry of entries) {
    if (entry.type === "equal") {
      insideChange = false;
    } else if (!insideChange) {
      blocks += 1;
      insideChange = true;
    }
  }
  return blocks;
}

export function diffTextLines(
  originalText: string,
  revisedText: string,
  options: TextDiffOptions = {},
): TextDiffResult {
  const limits = normalizeLimits(options.limits);
  const originalLines = splitTextLines(originalText);
  const revisedLines = splitTextLines(revisedText);

  const originalIssue = validateInput(
    originalText,
    originalLines,
    "original",
    limits,
  );
  if (originalIssue) return { ok: false, error: originalIssue };

  const revisedIssue = validateInput(
    revisedText,
    revisedLines,
    "revised",
    limits,
  );
  if (revisedIssue) return { ok: false, error: revisedIssue };

  const originalKeys = originalLines.map((line) =>
    comparisonKey(line, options),
  );
  const revisedKeys = revisedLines.map((line) => comparisonKey(line, options));
  const primitive = createPrimitiveDiff(
    originalKeys,
    revisedKeys,
    limits.maxTraceCells,
  );

  if (!primitive) {
    return {
      ok: false,
      error: {
        code: "comparison-too-complex",
        limit: limits.maxTraceCells,
        message:
          "差异路径过于复杂，已在达到安全计算预算前停止。请缩短文本、分段比较，或启用忽略空白/大小写后重试。",
      },
    };
  }

  const entries = createEntries(primitive, originalLines, revisedLines);
  const stats: TextDiffStats = {
    originalLines: originalLines.length,
    revisedLines: revisedLines.length,
    added: entries.filter((entry) => entry.type === "added").length,
    removed: entries.filter((entry) => entry.type === "removed").length,
    unchanged: entries.filter((entry) => entry.type === "equal").length,
    changedBlocks: countChangedBlocks(entries),
  };

  return {
    ok: true,
    entries,
    sideBySide: createSideBySideRows(entries),
    unified: createUnifiedDiff(
      entries,
      originalLines.length,
      revisedLines.length,
    ),
    stats,
  };
}

import { describe, expect, it } from "vitest";

import {
  countTextLines,
  diffTextLines,
  getTextByteLength,
  splitTextLines,
} from "../../src/tools/text-diff";

describe("text diff core", () => {
  it("returns a shortest script across small repeated-line combinations", () => {
    const sequences: string[][] = [[]];
    for (let length = 1; length <= 4; length += 1) {
      for (let mask = 0; mask < 2 ** length; mask += 1) {
        sequences.push(
          Array.from({ length }, (_, index) =>
            mask & (1 << index) ? "a" : "b",
          ),
        );
      }
    }

    function lcsLength(left: readonly string[], right: readonly string[]) {
      let previous = new Array<number>(right.length + 1).fill(0);
      for (const leftLine of left) {
        const current = new Array<number>(right.length + 1).fill(0);
        for (let index = 1; index <= right.length; index += 1) {
          current[index] =
            leftLine === right[index - 1]
              ? (previous[index - 1] ?? 0) + 1
              : Math.max(previous[index] ?? 0, current[index - 1] ?? 0);
        }
        previous = current;
      }
      return previous[right.length] ?? 0;
    }

    for (const original of sequences) {
      for (const revised of sequences) {
        const result = diffTextLines(original.join("\n"), revised.join("\n"));
        expect(result.ok).toBe(true);
        if (!result.ok) continue;

        const actualEdits = result.stats.added + result.stats.removed;
        const expectedEdits =
          original.length + revised.length - 2 * lcsLength(original, revised);
        expect(actualEdits).toBe(expectedEdits);
      }
    }
  });

  it("creates a shortest line-level edit sequence with stable line numbers", () => {
    const result = diffTextLines(
      ["alpha", "beta", "gamma", "omega"].join("\n"),
      ["alpha", "beta changed", "gamma", "delta", "omega"].join("\n"),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.entries).toEqual([
      {
        type: "equal",
        original: { lineNumber: 1, text: "alpha" },
        revised: { lineNumber: 1, text: "alpha" },
      },
      {
        type: "removed",
        original: { lineNumber: 2, text: "beta" },
        revised: null,
      },
      {
        type: "added",
        original: null,
        revised: { lineNumber: 2, text: "beta changed" },
      },
      {
        type: "equal",
        original: { lineNumber: 3, text: "gamma" },
        revised: { lineNumber: 3, text: "gamma" },
      },
      {
        type: "added",
        original: null,
        revised: { lineNumber: 4, text: "delta" },
      },
      {
        type: "equal",
        original: { lineNumber: 4, text: "omega" },
        revised: { lineNumber: 5, text: "omega" },
      },
    ]);
    expect(result.stats).toEqual({
      originalLines: 4,
      revisedLines: 5,
      added: 2,
      removed: 1,
      unchanged: 3,
      changedBlocks: 2,
    });
  });

  it("pairs adjacent removals and additions for the side-by-side view", () => {
    const result = diffTextLines("one\ntwo\nthree", "one\nsecond\nthird\nfour");

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.sideBySide).toEqual([
      {
        type: "equal",
        original: { lineNumber: 1, text: "one" },
        revised: { lineNumber: 1, text: "one" },
      },
      {
        type: "changed",
        original: { lineNumber: 2, text: "two" },
        revised: { lineNumber: 2, text: "second" },
      },
      {
        type: "changed",
        original: { lineNumber: 3, text: "three" },
        revised: { lineNumber: 3, text: "third" },
      },
      {
        type: "added",
        original: null,
        revised: { lineNumber: 4, text: "four" },
      },
    ]);
  });

  it("builds a copyable unified diff", () => {
    const result = diffTextLines("keep\nold", "keep\nnew");

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.unified).toBe(
      [
        "--- 原文",
        "+++ 新文本",
        "@@ -1,2 +1,2 @@",
        " keep",
        "-old",
        "+new",
      ].join("\n"),
    );
  });

  it("can ignore whitespace and case while retaining both source spellings", () => {
    const result = diffTextLines(
      "Hello   World\nVALUE = 1",
      "hello world\nvalue=1",
      {
        ignoreWhitespace: true,
        ignoreCase: true,
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.stats).toMatchObject({ added: 0, removed: 0, unchanged: 2 });
    expect(result.entries[0]).toEqual({
      type: "equal",
      original: { lineNumber: 1, text: "Hello   World" },
      revised: { lineNumber: 1, text: "hello world" },
    });
  });

  it("normalizes CRLF and CR but preserves a trailing empty line", () => {
    expect(splitTextLines("a\r\nb\rc\n")).toEqual(["a", "b", "c", ""]);
    expect(countTextLines("")).toBe(0);
    expect(countTextLines("a\n")).toBe(2);

    const result = diffTextLines("a\r\nb", "a\nb");
    expect(result.ok && result.stats.unchanged).toBe(2);
  });

  it("handles empty inputs and one-sided text", () => {
    const empty = diffTextLines("", "");
    expect(empty.ok).toBe(true);
    if (empty.ok) {
      expect(empty.entries).toEqual([]);
      expect(empty.stats).toMatchObject({
        originalLines: 0,
        revisedLines: 0,
        added: 0,
        removed: 0,
      });
    }

    const added = diffTextLines("", "first\nsecond");
    expect(added.ok && added.stats.added).toBe(2);
  });

  it("counts UTF-8 bytes and rejects either input above its byte limit", () => {
    expect(getTextByteLength("中🙂")).toBe(7);

    const result = diffTextLines("ok", "中🙂", {
      limits: { maxBytesPerInput: 6 },
    });
    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: "input-too-large",
        side: "revised",
        actual: 7,
        limit: 6,
      }),
    });
  });

  it("rejects either input above its line limit", () => {
    const result = diffTextLines("one\ntwo\nthree", "one", {
      limits: { maxLinesPerInput: 2 },
    });
    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: "too-many-lines",
        side: "original",
        actual: 3,
        limit: 2,
      }),
    });
  });

  it("allows stricter embedding limits but never raises the hard caps", () => {
    const tooManyLines = `${"x\n".repeat(5_000)}x`;
    const result = diffTextLines(tooManyLines, "", {
      limits: { maxLinesPerInput: 10_000 },
    });

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: "too-many-lines",
        actual: 5_001,
        limit: 5_000,
      }),
    });
  });

  it("stops a complex shared comparison at the trace budget", () => {
    const result = diffTextLines("a\nshared\nb", "x\nshared\ny", {
      limits: { maxTraceCells: 3 },
    });

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "comparison-too-complex" }),
    });
  });

  it("uses a linear fast path for disjoint rewrites even with a tiny trace budget", () => {
    const original = Array.from({ length: 200 }, (_, index) => `old ${index}`);
    const revised = Array.from({ length: 200 }, (_, index) => `new ${index}`);
    const result = diffTextLines(original.join("\n"), revised.join("\n"), {
      limits: { maxTraceCells: 3 },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.stats).toMatchObject({ added: 200, removed: 200 });
    }
  });

  it("matches duplicate lines without losing or inventing content", () => {
    const result = diffTextLines("same\na\nsame\nb", "same\nb\nsame\na");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(
      result.entries.filter((entry) => entry.type === "equal"),
    ).toHaveLength(2);
    expect(
      result.entries.filter((entry) => entry.type === "added"),
    ).toHaveLength(2);
    expect(
      result.entries.filter((entry) => entry.type === "removed"),
    ).toHaveLength(2);
  });
});

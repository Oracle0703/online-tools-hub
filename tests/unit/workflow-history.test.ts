import { describe, expect, it } from "vitest";

import {
  MAX_WORKFLOW_HISTORY_ENTRIES,
  WorkflowHistory,
} from "../../src/workflows/history";
import {
  WORKFLOW_RECIPE_FORMAT,
  WORKFLOW_RECIPE_VERSION,
  type WorkflowRecipeV1,
} from "../../src/workflows/contract";
import { WorkflowError } from "../../src/workflows/errors";

function recipe(index: number): WorkflowRecipeV1 {
  return {
    format: WORKFLOW_RECIPE_FORMAT,
    version: WORKFLOW_RECIPE_VERSION,
    steps: [
      {
        operationId: "json.transform",
        options: { mode: "format", indent: index },
      },
    ],
  };
}

describe("WorkflowHistory", () => {
  it("stores only normalized, deeply frozen recipe structures", () => {
    const history = new WorkflowHistory({
      normalization: {
        validateOperationId: (operationId) => operationId === "json.transform",
        normalizeOptions: (_operationId, options) => ({
          ...options,
          explicitDefault: true,
        }),
      },
    });
    const source = recipe(2) as WorkflowRecipeV1 & {
      runtimeSecret?: string;
    };
    const saved = history.record(source);

    expect(saved).not.toBe(source);
    expect(Object.isFrozen(saved)).toBe(true);
    expect(Object.isFrozen(saved.steps)).toBe(true);
    expect(Object.isFrozen(saved.steps[0])).toBe(true);
    expect(Object.isFrozen(saved.steps[0]?.options)).toBe(true);
    expect(saved.steps[0]?.options).toMatchObject({ explicitDefault: true });
    expect(history.recipes()).toEqual([saved]);
    expect(Object.isFrozen(history.recipes())).toBe(true);
    expect(JSON.stringify(history.recipes())).not.toMatch(
      /payload|filename|hash|result|runtimeSecret/i,
    );
  });

  it("rejects payload-bearing envelopes without changing existing history", () => {
    const history = new WorkflowHistory();
    history.record(recipe(2));
    const payloadBearing = {
      ...recipe(4),
      payload: { kind: "text", text: "must-not-survive" },
    };

    expect(() => history.record(payloadBearing)).toThrow(WorkflowError);
    expect(history.snapshot()).toEqual({
      entries: 1,
      cursor: 0,
      canUndo: false,
      canRedo: false,
    });
    expect(JSON.stringify(history.recipes())).not.toContain("must-not-survive");
  });

  it("provides bounded undo/redo and discards redo after a new branch", () => {
    const history = new WorkflowHistory();
    const first = history.record(recipe(1));
    const second = history.record(recipe(2));
    const third = history.record(recipe(3));

    expect(history.current()).toEqual(third);
    expect(history.undo()).toEqual(second);
    expect(history.undo()).toEqual(first);
    expect(history.undo()).toBeUndefined();
    expect(history.redo()).toEqual(second);

    const branch = history.record(recipe(4));
    expect(history.current()).toEqual(branch);
    expect(history.redo()).toBeUndefined();
    expect(history.recipes()).toEqual([first, second, branch]);
    expect(history.snapshot()).toEqual({
      entries: 3,
      cursor: 2,
      canUndo: true,
      canRedo: false,
    });
  });

  it("deduplicates equivalent canonical recipes", () => {
    const history = new WorkflowHistory();
    const first = history.record(recipe(2));
    const equivalent = {
      steps: [
        {
          options: { indent: 2, mode: "format" },
          operationId: "json.transform",
        },
      ],
      version: WORKFLOW_RECIPE_VERSION,
      format: WORKFLOW_RECIPE_FORMAT,
    };

    expect(history.record(equivalent)).toBe(first);
    expect(history.snapshot().entries).toBe(1);
  });

  it("never retains more than eight recipes", () => {
    expect(MAX_WORKFLOW_HISTORY_ENTRIES).toBe(8);
    const history = new WorkflowHistory();
    for (let index = 0; index < 12; index += 1) history.record(recipe(index));

    expect(history.snapshot()).toMatchObject({
      entries: 8,
      cursor: 7,
      canUndo: true,
      canRedo: false,
    });
    expect(history.recipes()[0]?.steps[0]?.options).toEqual({
      indent: 4,
      mode: "format",
    });
    let undoCount = 0;
    while (history.undo() !== undefined) undoCount += 1;
    expect(undoCount).toBe(7);
  });

  it("allows a smaller cap but rejects any attempt to raise the hard bound", () => {
    const history = new WorkflowHistory({ maxEntries: 2 });
    history.record(recipe(1));
    history.record(recipe(2));
    history.record(recipe(3));
    expect(history.recipes()).toHaveLength(2);

    expect(() => new WorkflowHistory({ maxEntries: 0 })).toThrow(RangeError);
    expect(
      () =>
        new WorkflowHistory({ maxEntries: MAX_WORKFLOW_HISTORY_ENTRIES + 1 }),
    ).toThrow(RangeError);
  });

  it("clears idempotently and cannot restore a cleared recipe", () => {
    const history = new WorkflowHistory();
    history.record(recipe(1));
    history.record(recipe(2));
    history.clear();
    history.clear();

    expect(history.current()).toBeUndefined();
    expect(history.undo()).toBeUndefined();
    expect(history.redo()).toBeUndefined();
    expect(history.recipes()).toEqual([]);
    expect(history.snapshot()).toEqual({
      entries: 0,
      cursor: -1,
      canUndo: false,
      canRedo: false,
    });
  });
});

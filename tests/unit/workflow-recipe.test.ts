import { describe, expect, it, vi } from "vitest";

import {
  MAX_WORKFLOW_RECIPE_BYTES,
  WORKFLOW_RECIPE_FORMAT,
} from "../../src/workflows/contract";
import { WorkflowError } from "../../src/workflows/errors";
import {
  exportWorkflowRecipeCanonical,
  migrateWorkflowRecipe,
  normalizeWorkflowRecipe,
  parseWorkflowRecipe,
} from "../../src/workflows/recipe-codec";

function recipe(steps: unknown[] = []): Record<string, unknown> {
  return { format: WORKFLOW_RECIPE_FORMAT, version: 1, steps };
}

function expectCode(run: () => unknown, code: WorkflowError["code"]): void {
  try {
    run();
    throw new Error("Expected a WorkflowError.");
  } catch (error) {
    expect(error).toBeInstanceOf(WorkflowError);
    expect((error as WorkflowError).code).toBe(code);
  }
}

describe("workflow recipe codec", () => {
  it("normalizes missing options, explicit defaults and deeply freezes output", () => {
    const normalized = normalizeWorkflowRecipe(
      recipe([{ operationId: "json.format" }]),
      {
        validateOperationId: (id) => id === "json.format",
        normalizeOptions: (_id, options) => ({ indent: 2, ...options }),
      },
    );

    expect(normalized).toEqual(
      recipe([{ operationId: "json.format", options: { indent: 2 } }]),
    );
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(Object.isFrozen(normalized.steps)).toBe(true);
    expect(Object.isFrozen(normalized.steps[0])).toBe(true);
    expect(Object.isFrozen(normalized.steps[0]?.options)).toBe(true);
  });

  it("exports only canonical fields with stable recursive key ordering", () => {
    const input = recipe([
      {
        operationId: "json.format",
        options: { z: true, nested: { z: 1, a: 2 }, a: -0 },
      },
    ]);
    (input as Record<string, unknown>).runtime = { payload: "secret" };
    expectCode(() => exportWorkflowRecipeCanonical(input), "invalid-recipe");
    delete input.runtime;

    expect(exportWorkflowRecipeCanonical(input)).toBe(
      '{"format":"online-tools-hub/workflow","version":1,"steps":[{"operationId":"json.format","options":{"a":0,"nested":{"a":2,"z":1},"z":true}}]}',
    );
  });

  it("parses v1 and refuses to invent v0 or accept future/foreign formats", () => {
    expect(parseWorkflowRecipe(JSON.stringify(recipe()))).toEqual(recipe());
    expectCode(
      () => migrateWorkflowRecipe({ ...recipe(), version: 0 }),
      "unsupported-version",
    );
    expectCode(
      () => migrateWorkflowRecipe({ ...recipe(), version: 2 }),
      "unsupported-version",
    );
    expectCode(
      () => migrateWorkflowRecipe({ ...recipe(), format: "foreign" }),
      "unsupported-format",
    );
  });

  it("enforces exact root/step fields and the sixteen-step maximum", () => {
    expectCode(
      () => normalizeWorkflowRecipe({ ...recipe(), status: "done" }),
      "invalid-recipe",
    );
    expectCode(
      () =>
        normalizeWorkflowRecipe(
          recipe([{ operationId: "json.format", input: "payload" }]),
        ),
      "invalid-recipe",
    );
    expectCode(
      () =>
        normalizeWorkflowRecipe(
          recipe(
            Array.from({ length: 17 }, () => ({ operationId: "json.format" })),
          ),
        ),
      "too-many-steps",
    );
  });

  it("enforces the raw UTF-8 64 KiB budget before JSON parsing", () => {
    expect(MAX_WORKFLOW_RECIPE_BYTES).toBe(64 * 1024);
    expectCode(
      () => parseWorkflowRecipe(` ${" ".repeat(MAX_WORKFLOW_RECIPE_BYTES)}`),
      "recipe-too-large",
    );
  });

  it.each([
    ["URL", { target: "https://example.com/private" }],
    ["protocol-relative URL", { target: "//example.com/private" }],
    ["script protocol", { target: "  javascript:alert(1)" }],
    ["obfuscated remote protocol", { target: "ht\ntps://example.com" }],
    ["data protocol", { target: "data:text/plain,secret" }],
  ])("rejects %s strings in options", (_name, options) => {
    expectCode(
      () =>
        normalizeWorkflowRecipe(recipe([{ operationId: "url.test", options }])),
      "unsafe-value",
    );
  });

  it("rejects protocol strings used as nested object keys", () => {
    expectCode(
      () =>
        normalizeWorkflowRecipe(
          recipe([
            {
              operationId: "json.format",
              options: { nested: { "javascript:alert(1)": true } },
            },
          ]),
        ),
      "unsafe-value",
    );
  });

  it("rejects dangerous keys at arbitrary depth", () => {
    for (const key of ["__proto__", "constructor", "prototype"]) {
      const input = JSON.parse(
        `{"format":"online-tools-hub/workflow","version":1,"steps":[{"operationId":"json.format","options":{"nested":{"${key}":true}}}]}`,
      ) as unknown;
      expectCode(() => normalizeWorkflowRecipe(input), "unsafe-value");
    }
  });

  it("rejects accessors and symbols without invoking getters", () => {
    let getterCalls = 0;
    const options: Record<PropertyKey, unknown> = { safe: true };
    Object.defineProperty(options, "secret", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return "https://example.com";
      },
    });
    expectCode(
      () =>
        normalizeWorkflowRecipe(
          recipe([{ operationId: "json.format", options }]),
        ),
      "unsafe-value",
    );
    expect(getterCalls).toBe(0);

    expectCode(
      () =>
        normalizeWorkflowRecipe(
          recipe([
            {
              operationId: "json.format",
              options: { [Symbol("secret")]: true },
            },
          ]),
        ),
      "unsafe-value",
    );
  });

  it("rejects sparse/custom arrays, class instances and excessive depth", () => {
    expectCode(
      () =>
        normalizeWorkflowRecipe(
          recipe([
            { operationId: "json.format", options: { values: new Array(2) } },
          ]),
        ),
      "unsafe-value",
    );
    expectCode(
      () =>
        normalizeWorkflowRecipe(
          recipe([
            { operationId: "json.format", options: { value: new Date() } },
          ]),
        ),
      "unsafe-value",
    );

    let nested: unknown = true;
    for (let index = 0; index < 40; index += 1) nested = { nested };
    expectCode(
      () =>
        normalizeWorkflowRecipe(
          recipe([{ operationId: "json.format", options: { nested } }]),
        ),
      "invalid-options",
    );
  });

  it("bounds the total option node count", () => {
    expectCode(
      () =>
        normalizeWorkflowRecipe(
          recipe([
            {
              operationId: "json.format",
              options: { values: Array.from({ length: 10_001 }, () => null) },
            },
          ]),
        ),
      "invalid-options",
    );
  });

  it("turns throwing Proxy traps and callback failures into redacted errors", () => {
    const proxy = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error("sensitive proxy detail");
        },
      },
    );
    expectCode(
      () =>
        normalizeWorkflowRecipe(
          recipe([{ operationId: "json.format", options: proxy }]),
        ),
      "unsafe-value",
    );

    expectCode(
      () =>
        normalizeWorkflowRecipe(
          recipe([{ operationId: "private.operation" }]),
          {
            validateOperationId: () => {
              throw new Error("private catalog detail");
            },
          },
        ),
      "unknown-operation",
    );
    try {
      normalizeWorkflowRecipe(recipe([{ operationId: "json.format" }]), {
        normalizeOptions: () => {
          throw new Error("input=secret");
        },
      });
    } catch (error) {
      expect(JSON.stringify(error)).not.toContain("secret");
      expect((error as Error).message).not.toContain("secret");
    }
  });

  it("validates every structure before calling injected catalog policy", () => {
    const validateOperationId = vi.fn(() => true);
    const input = recipe([
      { operationId: "json.format" },
      { operationId: "url.decode", options: { target: "javascript:alert(1)" } },
    ]);
    expectCode(
      () => normalizeWorkflowRecipe(input, { validateOperationId }),
      "unsafe-value",
    );
    expect(validateOperationId).not.toHaveBeenCalled();
  });
});

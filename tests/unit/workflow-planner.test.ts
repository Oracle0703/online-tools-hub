import { describe, expect, it, vi } from "vitest";

import type {
  JsonObject,
  OperationManifest,
  OperationSemanticSignature,
} from "../../src/operations/contract";
import { getOperationManifest } from "../../src/operations/catalog";
import {
  assertWorkflowInitialPayload,
  compileWorkflowCandidate,
  compileWorkflowRecipe,
  type WorkflowPlannerDependencies,
} from "../../src/workflows/planner";
import {
  WORKFLOW_RECIPE_FORMAT,
  WORKFLOW_RECIPE_VERSION,
  type WorkflowRecipeV1,
} from "../../src/workflows/contract";
import { WorkflowError } from "../../src/workflows/errors";
import { workflowTemplates } from "../../src/workflows/templates";

function recipe(steps: WorkflowRecipeV1["steps"]): WorkflowRecipeV1 {
  return {
    format: WORKFLOW_RECIPE_FORMAT,
    version: WORKFLOW_RECIPE_VERSION,
    steps,
  };
}

function fixtureManifest(
  signatures: readonly OperationSemanticSignature[],
): OperationManifest {
  return {
    version: 1,
    id: "fixture.transform",
    toolSlug: "json-formatter",
    inputKinds: ["text"],
    outputKinds: ["text"],
    maxInputBytes: 1024,
    maxOutputBytes: 1024,
    workingMemoryBytes: 2048,
    options: {
      additionalProperties: "forbidden",
      properties: {},
    },
    signatures,
    determinism: "deterministic",
    execution: {
      strategy: "main",
      workerThresholdBytes: null,
      timeoutMs: 1000,
    },
    capabilities: {
      network: "forbidden",
      persistence: "forbidden",
      environment: [],
    },
  };
}

function fixtureDependencies(
  manifest: OperationManifest,
): WorkflowPlannerDependencies {
  return {
    getManifest: (operationId) =>
      operationId === manifest.id ? manifest : undefined,
    normalizeOptions: (_manifest, options) => Object.freeze({ ...options }),
    resolveSignature: () => manifest.signatures[0]!,
  };
}

describe("workflow planner", () => {
  it("compiles every built-in template using manifest data only", () => {
    for (const template of workflowTemplates) {
      const plan = compileWorkflowCandidate(template.recipe);

      expect(plan.steps).toHaveLength(template.recipe.steps.length);
      expect(plan.steps.length).toBeGreaterThanOrEqual(2);
      expect(plan.steps.length).toBeLessThanOrEqual(4);
      expect(plan.recipe).not.toHaveProperty("payload");
      expect(plan.steps.map((step) => step.stepId)).toEqual(
        plan.steps.map((_, index) => `workflow-step-${index + 1}`),
      );
      expect(Object.isFrozen(plan)).toBe(true);
      expect(Object.isFrozen(plan.recipe.steps)).toBe(true);
      expect(plan.maxWorkingMemoryBytes).toBe(
        Math.max(...plan.steps.map((step) => step.workingMemoryBytes)),
      );

      assertWorkflowInitialPayload(plan, {
        kind: template.input.kind,
        semanticType: template.input.contentType,
        bytes: 1,
      });
    }
  });

  it("materializes static defaults and never exports runtime step IDs", () => {
    const plan = compileWorkflowCandidate(
      recipe([{ operationId: "json.transform", options: {} }]),
    );

    expect(plan.steps[0]?.options).toEqual({ mode: "format", indent: 2 });
    expect(plan.recipe.steps[0]).toEqual({
      operationId: "json.transform",
      options: { mode: "format", indent: 2 },
    });
    expect(plan.recipe.steps[0]).not.toHaveProperty("stepId");
  });

  it("rejects unknown operations and bad options before signature resolution", () => {
    const resolveSignature = vi.fn();
    const knownManifest = getOperationManifest("json.transform")!;
    const dependencies: WorkflowPlannerDependencies = {
      getManifest: (operationId) =>
        operationId === knownManifest.id ? knownManifest : undefined,
      normalizeOptions: () => {
        throw new Error("adapter loader must not run");
      },
      resolveSignature,
    };

    expect(() =>
      compileWorkflowCandidate(
        recipe([{ operationId: "missing.operation", options: {} }]),
        dependencies,
      ),
    ).toThrow(expect.objectContaining({ code: "unknown-operation" }));
    expect(() =>
      compileWorkflowCandidate(
        recipe([{ operationId: "json.transform", options: {} }]),
        dependencies,
      ),
    ).toThrow(expect.objectContaining({ code: "invalid-options" }));
    expect(resolveSignature).not.toHaveBeenCalled();
  });

  it("reports the exact incompatible step without importing an adapter", () => {
    expect(() =>
      compileWorkflowCandidate(
        recipe([
          {
            operationId: "base64.codec",
            options: { mode: "encode", variant: "standard" },
          },
          {
            operationId: "json.transform",
            options: { mode: "format" },
          },
        ]),
      ),
    ).toThrow(
      expect.objectContaining({
        code: "incompatible-step",
        stepIndex: 1,
        operationId: "json.transform",
      }),
    );
  });

  it("uses the resolved signature determinism and accepts MIME wildcards", () => {
    const signature: OperationSemanticSignature = {
      when: {},
      input: [{ kind: "text", contentType: "text/*" }],
      output: { kind: "text", contentType: "application/json" },
      determinism: "context-dependent",
    };
    const manifest = fixtureManifest([signature]);
    const plan = compileWorkflowRecipe(
      recipe([{ operationId: manifest.id, options: {} }]),
      fixtureDependencies(manifest),
    );

    expect(plan.deterministic).toBe(false);
    expect(plan.steps[0]?.determinism).toBe("context-dependent");
    expect(() =>
      assertWorkflowInitialPayload(plan, {
        kind: "text",
        semanticType: "text/plain",
        bytes: 5,
      }),
    ).not.toThrow();
    expect(() =>
      assertWorkflowInitialPayload(plan, {
        kind: "binary",
        semanticType: "text/plain",
        bytes: 5,
      }),
    ).toThrow(expect.objectContaining({ code: "incompatible-step" }));
  });

  it("rejects empty plans and wraps signature failures as invalid options", () => {
    const manifest = fixtureManifest([
      {
        when: {},
        input: [{ kind: "text", contentType: "text/plain" }],
        output: { kind: "text", contentType: "text/plain" },
        determinism: "deterministic",
      },
    ]);
    const dependencies = fixtureDependencies(manifest);

    expect(() => compileWorkflowRecipe(recipe([]), dependencies)).toThrow(
      expect.objectContaining({ code: "invalid-recipe" }),
    );
    expect(() =>
      compileWorkflowRecipe(recipe([{ operationId: "unknown", options: {} }]), {
        ...dependencies,
        getManifest: () => undefined,
      }),
    ).toThrow(expect.objectContaining({ code: "unknown-operation" }));
    expect(() =>
      compileWorkflowRecipe(
        recipe([{ operationId: manifest.id, options: {} }]),
        {
          ...dependencies,
          resolveSignature(): OperationSemanticSignature {
            throw new Error("no signature");
          },
        },
      ),
    ).toThrow(expect.objectContaining({ code: "invalid-options" }));
  });

  it("keeps public Workflow errors payload-free", () => {
    const error = new WorkflowError("operation-failed", {
      stepIndex: 2,
      operationId: "json.transform",
      details: { reason: "safe-code" } as JsonObject,
      cause: new Error("secret input fragment"),
    });

    expect(JSON.stringify(error)).not.toContain("secret input fragment");
    expect(error.message).toBe("The workflow operation failed.");
  });
});

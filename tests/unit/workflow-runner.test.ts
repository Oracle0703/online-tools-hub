import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  OperationDefinition,
  OperationExecute,
  OperationManifest,
} from "../../src/operations/contract";
import {
  getActiveOperationMemoryBytes,
  getActiveOperationTaskCount,
  getActiveOperationWorkerCount,
  OperationExecutor,
  type OperationPageLifecycleTarget,
} from "../../src/operations/executor";
import {
  normalizeOperationOptions,
  resolveOperationSignature,
} from "../../src/operations/validation";
import {
  WORKFLOW_RECIPE_FORMAT,
  WORKFLOW_RECIPE_VERSION,
  type WorkflowRecipeV1,
} from "../../src/workflows/contract";
import { WorkflowError } from "../../src/workflows/errors";
import { PayloadVault } from "../../src/workflows/payload-vault";
import {
  compileWorkflowRecipe,
  type WorkflowPlan,
} from "../../src/workflows/planner";
import { WorkflowRunner } from "../../src/workflows/runner";

interface FixtureStep {
  readonly id: string;
  readonly execute: OperationExecute;
  readonly workingMemoryBytes?: number;
}

const runners: WorkflowRunner[] = [];

afterEach(() => {
  for (const runner of runners.splice(0)) runner.dispose();
  expect(getActiveOperationMemoryBytes()).toBe(0);
  expect(getActiveOperationTaskCount()).toBe(0);
  expect(getActiveOperationWorkerCount()).toBe(0);
  vi.restoreAllMocks();
});

function manifestFor(step: FixtureStep): OperationManifest {
  const workingMemoryBytes = step.workingMemoryBytes ?? 1024;
  return {
    version: 1,
    id: step.id,
    toolSlug: "json-formatter",
    inputKinds: ["text"],
    outputKinds: ["text"],
    maxInputBytes: workingMemoryBytes,
    maxOutputBytes: workingMemoryBytes,
    workingMemoryBytes,
    options: {
      additionalProperties: "forbidden",
      properties: {},
    },
    signatures: [
      {
        when: {},
        input: [{ kind: "text", contentType: "text/plain" }],
        output: { kind: "text", contentType: "text/plain" },
        determinism: "deterministic",
      },
    ],
    determinism: "deterministic",
    execution: {
      strategy: "main",
      workerThresholdBytes: null,
      timeoutMs: 5000,
    },
    capabilities: {
      network: "forbidden",
      persistence: "forbidden",
      environment: [],
    },
  };
}

function recipeFor(steps: readonly FixtureStep[]): WorkflowRecipeV1 {
  return {
    format: WORKFLOW_RECIPE_FORMAT,
    version: WORKFLOW_RECIPE_VERSION,
    steps: steps.map((step) => ({ operationId: step.id, options: {} })),
  };
}

function createFixture(
  steps: readonly FixtureStep[],
  options: {
    readonly maxResidentBytes?: number;
    readonly vaultMaxBytes?: number;
    readonly vaultMaxEntries?: number;
  } = {},
): { runner: WorkflowRunner; plan: WorkflowPlan; vault: PayloadVault } {
  const manifests = new Map(
    steps.map((step) => [step.id, manifestFor(step)] as const),
  );
  const definitions = new Map(
    steps.map(
      (step) =>
        [
          step.id,
          {
            manifest: manifests.get(step.id)!,
            execute: step.execute,
          } satisfies OperationDefinition,
        ] as const,
    ),
  );
  let taskSequence = 0;
  const executor = new OperationExecutor({
    maxActiveMemoryBytes: 2 * 1024 * 1024,
    maxActiveWorkers: 0,
    taskIdFactory: () => `runner-task-${++taskSequence}`,
    getManifest: (operationId) => manifests.get(operationId),
    loadDefinition: async (operationId) => definitions.get(operationId)!,
  });
  let payloadSequence = 0;
  const vault = new PayloadVault({
    maxBytes: options.vaultMaxBytes,
    maxEntries: options.vaultMaxEntries,
    idFactory: () => `runner-payload-${++payloadSequence}`,
  });
  let runSequence = 0;
  const runner = new WorkflowRunner({
    executor,
    vault,
    disposeExecutor: true,
    maxResidentBytes: options.maxResidentBytes,
    runIdFactory: () => `runner-run-${++runSequence}`,
  });
  runners.push(runner);
  const plan = compileWorkflowRecipe(recipeFor(steps), {
    getManifest: (operationId) => manifests.get(operationId),
    normalizeOptions: normalizeOperationOptions,
    resolveSignature: resolveOperationSignature,
  });
  return { runner, plan, vault };
}

function putText(vault: PayloadVault, text = "input") {
  return vault.put({ kind: "text", text }, "text/plain");
}

class FakePageLifecycleTarget implements OperationPageLifecycleTarget {
  listener: (() => void) | undefined;

  addEventListener(type: "pagehide", listener: () => void): void {
    if (type === "pagehide") this.listener = listener;
  }

  removeEventListener(type: "pagehide", listener: () => void): void {
    if (type === "pagehide" && this.listener === listener) {
      this.listener = undefined;
    }
  }

  pageHide(): void {
    this.listener?.();
  }
}

describe("WorkflowRunner", () => {
  it("executes steps serially and keeps only opaque payload IDs in snapshots", async () => {
    const order: string[] = [];
    const steps: FixtureStep[] = [
      {
        id: "fixture.first",
        execute(input) {
          order.push("first");
          if (input.kind !== "text") throw new Error("unexpected input");
          return { kind: "text", text: `${input.text}-one` };
        },
      },
      {
        id: "fixture.second",
        execute(input) {
          order.push("second");
          if (input.kind !== "text") throw new Error("unexpected input");
          return { kind: "text", text: `${input.text}-two` };
        },
      },
    ];
    const { runner, plan, vault } = createFixture(steps);
    const initial = putText(vault, "start");

    const result = await runner.start(plan, initial.id).promise;

    expect(order).toEqual(["first", "second"]);
    expect(vault.preview(result.finalPayloadId)).toMatchObject({
      kind: "text",
      text: "start-one-two",
    });
    expect(result.snapshot.status).toBe("succeeded");
    expect(result.snapshot.steps.map((step) => step.status)).toEqual([
      "succeeded",
      "succeeded",
    ]);
    expect(vault.snapshot().entries).toBe(3);
    expect(JSON.stringify(runner.snapshot())).not.toContain("start-one-two");
    expect(runner.snapshot()).toMatchObject({ activeRunCount: 0 });
  });

  it("cancels synchronously, clears every payload and ignores a late result", async () => {
    let resolveLate!: (value: { kind: "text"; text: string }) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const late = new Promise<{ kind: "text"; text: string }>((resolve) => {
      resolveLate = resolve;
    });
    const { runner, plan, vault } = createFixture([
      {
        id: "fixture.pending",
        execute() {
          markStarted();
          return late;
        },
      },
    ]);
    const initial = putText(vault, "private-body");
    const run = runner.start(plan, initial.id);
    const rejection = run.promise.catch((error: unknown) => error);
    await started;

    expect(run.cancel()).toBe(true);
    expect(run.cancel()).toBe(false);
    await expect(rejection).resolves.toEqual(
      expect.objectContaining({ code: "cancelled" }),
    );
    expect(vault.snapshot()).toMatchObject({ entries: 0, bytes: 0 });
    expect(runner.snapshot().run).toMatchObject({
      status: "cancelled",
      activeStepIndex: null,
    });
    expect(runner.snapshot().run?.steps[0]).not.toHaveProperty(
      "inputPayloadId",
    );

    resolveLate({ kind: "text", text: "must-not-resurrect" });
    await Promise.resolve();
    await Promise.resolve();
    expect(vault.snapshot()).toMatchObject({ entries: 0, bytes: 0 });
    expect(runner.snapshot().activeRunCount).toBe(0);
  });

  it("keeps successful intermediate results after a step failure for inspection", async () => {
    const { runner, plan, vault } = createFixture([
      {
        id: "fixture.prepare",
        execute() {
          return { kind: "text", text: "intermediate" };
        },
      },
      {
        id: "fixture.fail",
        execute() {
          throw new Error("secret input must not escape");
        },
      },
    ]);
    const initial = putText(vault, "private-body");
    const run = runner.start(plan, initial.id);

    await expect(run.promise).rejects.toEqual(
      expect.objectContaining({
        code: "operation-failed",
        stepIndex: 1,
        operationId: "fixture.fail",
      }),
    );
    expect(runner.snapshot().run?.steps.map((step) => step.status)).toEqual([
      "succeeded",
      "failed",
    ]);
    expect(vault.snapshot().entries).toBe(2);
    expect(JSON.stringify(runner.snapshot())).not.toContain("private-body");
    expect(JSON.stringify(runner.snapshot())).not.toContain(
      "secret input must not escape",
    );

    runner.clear();
    expect(vault.snapshot()).toMatchObject({ entries: 0, bytes: 0 });
    expect(runner.snapshot().run).toBeNull();
  });

  it("rejects concurrent runs and enforces resident memory before execution", async () => {
    let resolveLate!: (value: { kind: "text"; text: string }) => void;
    const late = new Promise<{ kind: "text"; text: string }>((resolve) => {
      resolveLate = resolve;
    });
    const fixture = createFixture([
      {
        id: "fixture.concurrent",
        execute: () => late,
      },
    ]);
    const initial = putText(fixture.vault, "input");
    const active = fixture.runner.start(fixture.plan, initial.id);

    expect(() => fixture.runner.start(fixture.plan, initial.id)).toThrow(
      expect.objectContaining({ code: "run-conflict" }),
    );
    resolveLate({ kind: "text", text: "done" });
    await active.promise;

    const limited = createFixture(
      [
        {
          id: "fixture.limited",
          workingMemoryBytes: 10,
          execute: () => ({ kind: "text", text: "unused" }),
        },
      ],
      { maxResidentBytes: 11 },
    );
    const tooLarge = putText(limited.vault, "x");
    expect(() => limited.runner.start(limited.plan, tooLarge.id)).toThrow(
      expect.objectContaining({ code: "vault-limit" }),
    );
  });

  it("enforces the combined Vault and next-step reservation after expansion", async () => {
    const { runner, plan, vault } = createFixture(
      [
        {
          id: "fixture.expand",
          workingMemoryBytes: 10,
          execute: () => ({ kind: "text", text: "1234567890" }),
        },
        {
          id: "fixture.after",
          workingMemoryBytes: 10,
          execute: () => ({ kind: "text", text: "unreachable" }),
        },
      ],
      { maxResidentBytes: 30 },
    );
    const initial = putText(vault, "x");

    await expect(runner.start(plan, initial.id).promise).rejects.toEqual(
      expect.objectContaining({
        code: "vault-limit",
        stepIndex: 1,
        operationId: "fixture.after",
      }),
    );
    expect(runner.snapshot().run?.steps.map((step) => step.status)).toEqual([
      "succeeded",
      "failed",
    ]);
  });

  it("maps Vault output limits to a canonical step error", async () => {
    const { runner, plan, vault } = createFixture(
      [
        {
          id: "fixture.output",
          execute: () => ({ kind: "text", text: "large output" }),
        },
      ],
      { vaultMaxEntries: 1 },
    );
    const initial = putText(vault, "input");

    await expect(runner.start(plan, initial.id).promise).rejects.toEqual(
      expect.objectContaining({
        code: "vault-limit",
        stepIndex: 0,
        operationId: "fixture.output",
      }),
    );
  });

  it("canonicalizes synchronous Operation admission failures with step metadata", async () => {
    const { runner, plan, vault } = createFixture([
      {
        id: "fixture.admission",
        workingMemoryBytes: 1,
        execute: () => ({ kind: "text", text: "unreachable" }),
      },
    ]);
    const initial = putText(vault, "🙂");

    await expect(runner.start(plan, initial.id).promise).rejects.toEqual(
      expect.objectContaining({
        code: "operation-failed",
        stepIndex: 0,
        operationId: "fixture.admission",
      }),
    );
  });

  it("clears on pagehide, unbinds idempotently and refuses work after dispose", async () => {
    let resolveLate!: (value: { kind: "text"; text: string }) => void;
    const late = new Promise<{ kind: "text"; text: string }>((resolve) => {
      resolveLate = resolve;
    });
    const { runner, plan, vault } = createFixture([
      { id: "fixture.pagehide", execute: () => late },
    ]);
    const target = new FakePageLifecycleTarget();
    const unbind = runner.bindPageHide(target);
    const initial = putText(vault, "private-body");
    const run = runner.start(plan, initial.id);
    const rejection = run.promise.catch((error: unknown) => error);

    target.pageHide();
    await expect(rejection).resolves.toEqual(
      expect.objectContaining({ code: "cancelled" }),
    );
    expect(vault.snapshot().entries).toBe(0);
    expect(runner.snapshot().run).toBeNull();
    unbind();
    unbind();
    expect(target.listener).toBeUndefined();

    resolveLate({ kind: "text", text: "late" });
    runner.dispose();
    runner.dispose();
    expect(runner.snapshot().disposed).toBe(true);
    expect(() => runner.bindPageHide(target)).toThrow(
      expect.objectContaining({ code: "cancelled" }),
    );
    expect(() => runner.start(plan, initial.id)).toThrow(
      expect.objectContaining({ code: "cancelled" }),
    );
  });

  it("validates constructor and run ID invariants", () => {
    expect(
      () =>
        new WorkflowRunner({
          maxResidentBytes: 0,
        }),
    ).toThrow(RangeError);

    const fixture = createFixture([
      {
        id: "fixture.invalid-run-id",
        execute: () => ({ kind: "text", text: "unused" }),
      },
    ]);
    const invalid = new WorkflowRunner({
      executor: new OperationExecutor({
        getManifest: () => undefined,
      }),
      vault: fixture.vault,
      runIdFactory: () => "not safe!",
    });
    runners.push(invalid);
    const initial = putText(fixture.vault, "input");
    expect(() => invalid.start(fixture.plan, initial.id)).toThrow(TypeError);
  });

  it("does not expose custom error messages through WorkflowError", () => {
    const error = new WorkflowError(
      "operation-failed",
      "private input fragment",
      { stepIndex: 0, operationId: "fixture.safe" },
    );
    expect(error.message).toBe("The workflow operation failed.");
    expect(JSON.stringify(error)).not.toContain("private input fragment");
  });
});

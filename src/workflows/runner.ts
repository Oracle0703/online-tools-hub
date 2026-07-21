import type {
  OperationInput,
  OperationOutput,
  OperationRequest,
} from "../operations/contract";
import type {
  OperationExecutorSnapshot,
  OperationPageLifecycleTarget,
  OperationTask,
} from "../operations/executor";
import { isOperationError } from "../operations/errors";
import { WorkflowError } from "./errors";
import {
  type PayloadHandle,
  type PayloadId,
  PayloadVault,
  PayloadVaultError,
} from "./payload-vault";
import {
  assertWorkflowInitialPayload,
  type WorkflowPlan,
  type WorkflowPlanStep,
} from "./planner";
import {
  WorkerOperationExecutor,
  type WorkflowOperationExecutor,
} from "./worker-executor";

export const DEFAULT_MAX_WORKFLOW_RESIDENT_BYTES = 768 * 1024 * 1024;

export type WorkflowStepStatus =
  "pending" | "running" | "succeeded" | "failed" | "cancelled";

export type WorkflowRunStatus =
  "running" | "succeeded" | "failed" | "cancelled";

export interface WorkflowStepSnapshot {
  readonly stepId: string;
  readonly index: number;
  readonly operationId: string;
  readonly status: WorkflowStepStatus;
  readonly inputPayloadId?: PayloadId;
  readonly outputPayloadId?: PayloadId;
  readonly errorCode?: string;
}

export interface WorkflowRunSnapshot {
  readonly runId: string;
  readonly status: WorkflowRunStatus;
  readonly activeStepIndex: number | null;
  readonly steps: readonly WorkflowStepSnapshot[];
}

export interface WorkflowRunResult {
  readonly runId: string;
  readonly finalPayloadId: PayloadId;
  readonly snapshot: WorkflowRunSnapshot;
}

export interface WorkflowRun {
  readonly runId: string;
  readonly promise: Promise<WorkflowRunResult>;
  cancel(): boolean;
}

export interface WorkflowRunnerSnapshot {
  readonly activeRunCount: 0 | 1;
  readonly generation: number;
  readonly disposed: boolean;
  readonly run: WorkflowRunSnapshot | null;
  readonly vault: ReturnType<PayloadVault["snapshot"]>;
  readonly executor: OperationExecutorSnapshot;
}

export interface WorkflowRunnerOptions {
  readonly executor?: WorkflowOperationExecutor;
  readonly vault?: PayloadVault;
  readonly runIdFactory?: () => string;
  readonly maxResidentBytes?: number;
  readonly disposeExecutor?: boolean;
}

interface MutableWorkflowStepSnapshot {
  stepId: string;
  index: number;
  operationId: string;
  status: WorkflowStepStatus;
  inputPayloadId?: PayloadId;
  outputPayloadId?: PayloadId;
  errorCode?: string;
}

interface ActiveWorkflowRun {
  readonly runId: string;
  readonly generation: number;
  readonly plan: WorkflowPlan;
  readonly steps: MutableWorkflowStepSnapshot[];
  readonly resolve: (result: WorkflowRunResult) => void;
  readonly reject: (error: WorkflowError) => void;
  activeTask: OperationTask | null;
  status: WorkflowRunStatus;
  activeStepIndex: number | null;
  settled: boolean;
}

let nextRunSequence = 0;

function defaultRunIdFactory(): string {
  nextRunSequence += 1;
  return `workflow-${Date.now().toString(36)}-${nextRunSequence.toString(36)}`;
}

function assertResidentLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError("maxResidentBytes must be a positive safe integer.");
  }
  return value;
}

function toOperationInput(vault: PayloadVault, id: PayloadId): OperationInput {
  return vault.materializeInput(id);
}

function freezeStepSnapshot(
  step: MutableWorkflowStepSnapshot,
): WorkflowStepSnapshot {
  return Object.freeze({
    stepId: step.stepId,
    index: step.index,
    operationId: step.operationId,
    status: step.status,
    ...(step.inputPayloadId === undefined
      ? {}
      : { inputPayloadId: step.inputPayloadId }),
    ...(step.outputPayloadId === undefined
      ? {}
      : { outputPayloadId: step.outputPayloadId }),
    ...(step.errorCode === undefined ? {} : { errorCode: step.errorCode }),
  });
}

function freezeRunSnapshot(run: ActiveWorkflowRun): WorkflowRunSnapshot {
  return Object.freeze({
    runId: run.runId,
    status: run.status,
    activeStepIndex: run.activeStepIndex,
    steps: Object.freeze(run.steps.map(freezeStepSnapshot)),
  });
}

function canonicalFailure(
  error: unknown,
  step: WorkflowPlanStep,
): WorkflowError {
  if (error instanceof WorkflowError) return error;
  if (isOperationError(error)) {
    return new WorkflowError(
      error.code === "cancelled" ? "cancelled" : "operation-failed",
      error.code === "cancelled"
        ? "Workflow execution was cancelled."
        : "Workflow Operation failed.",
      {
        stepIndex: step.index,
        operationId: step.operationId,
        details: { operationCode: error.code },
        cause: error,
      },
    );
  }
  return new WorkflowError("operation-failed", "Workflow Operation failed.", {
    stepIndex: step.index,
    operationId: step.operationId,
    cause: error,
  });
}

function canonicalVaultFailure(
  error: unknown,
  step: WorkflowPlanStep,
): WorkflowError {
  if (
    error instanceof PayloadVaultError &&
    (error.code === "entry-limit" || error.code === "memory-budget")
  ) {
    return new WorkflowError("vault-limit", {
      stepIndex: step.index,
      operationId: step.operationId,
    });
  }
  return new WorkflowError("operation-failed", {
    stepIndex: step.index,
    operationId: step.operationId,
  });
}

/** Serial, single-run workflow coordinator. Payload bodies stay in the Vault. */
export class WorkflowRunner {
  readonly #executor: WorkflowOperationExecutor;
  readonly #vault: PayloadVault;
  readonly #runIdFactory: () => string;
  readonly #maxResidentBytes: number;
  readonly #disposeExecutor: boolean;
  #active: ActiveWorkflowRun | null = null;
  #lastRun: WorkflowRunSnapshot | null = null;
  #generation = 0;
  #disposed = false;
  #pageLifecycleTarget: OperationPageLifecycleTarget | null = null;

  readonly #pageHideListener = () => {
    this.clear();
  };

  constructor(options: WorkflowRunnerOptions = {}) {
    this.#executor = options.executor ?? new WorkerOperationExecutor();
    this.#vault = options.vault ?? new PayloadVault();
    this.#runIdFactory = options.runIdFactory ?? defaultRunIdFactory;
    this.#maxResidentBytes = assertResidentLimit(
      options.maxResidentBytes ?? DEFAULT_MAX_WORKFLOW_RESIDENT_BYTES,
    );
    this.#disposeExecutor =
      options.disposeExecutor ?? options.executor === undefined;
  }

  get vault(): PayloadVault {
    return this.#vault;
  }

  start(plan: WorkflowPlan, initialPayloadId: PayloadId): WorkflowRun {
    if (this.#disposed) {
      throw new WorkflowError("cancelled", "Workflow Runner is disposed.");
    }
    if (this.#active !== null) {
      throw new WorkflowError(
        "run-conflict",
        "Only one Workflow may run at a time.",
      );
    }

    const metadata = this.#vault.metadata(initialPayloadId);
    assertWorkflowInitialPayload(plan, metadata);
    if (metadata.bytes > this.#maxResidentBytes - plan.maxWorkingMemoryBytes) {
      throw new WorkflowError(
        "vault-limit",
        "Workflow input and Operation reservation exceed the resident budget.",
      );
    }

    const runId = this.#runIdFactory();
    if (typeof runId !== "string" || !/^[A-Za-z0-9_-]{1,256}$/u.test(runId)) {
      throw new TypeError("runIdFactory must return a safe non-empty ID.");
    }
    this.#generation += 1;

    let resolvePromise!: (result: WorkflowRunResult) => void;
    let rejectPromise!: (error: WorkflowError) => void;
    const promise = new Promise<WorkflowRunResult>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const steps = plan.steps.map<MutableWorkflowStepSnapshot>((step) => ({
      stepId: step.stepId,
      index: step.index,
      operationId: step.operationId,
      status: "pending",
    }));
    if (steps[0] !== undefined) steps[0].inputPayloadId = initialPayloadId;

    const active: ActiveWorkflowRun = {
      runId,
      generation: this.#generation,
      plan,
      steps,
      resolve: resolvePromise,
      reject: rejectPromise,
      activeTask: null,
      status: "running",
      activeStepIndex: null,
      settled: false,
    };
    this.#active = active;
    void this.#execute(active);

    return Object.freeze({
      runId,
      promise,
      cancel: () => this.cancel(runId),
    });
  }

  cancel(runId?: string): boolean {
    const active = this.#active;
    if (
      active === null ||
      active.settled ||
      (runId !== undefined && active.runId !== runId)
    ) {
      return false;
    }

    this.#generation += 1;
    active.activeTask?.cancel();
    active.activeTask = null;
    active.status = "cancelled";
    active.activeStepIndex = null;
    for (const step of active.steps) {
      if (step.status === "pending" || step.status === "running") {
        step.status = "cancelled";
      }
      delete step.inputPayloadId;
      delete step.outputPayloadId;
    }
    this.#vault.clear();
    this.#settleFailure(
      active,
      new WorkflowError("cancelled", "Workflow execution was cancelled."),
    );
    return true;
  }

  clear(): void {
    this.cancel();
    this.#vault.clear();
    this.#lastRun = null;
  }

  bindPageHide(target: OperationPageLifecycleTarget): () => void {
    if (this.#disposed) {
      throw new WorkflowError("cancelled", "Workflow Runner is disposed.");
    }
    this.unbindPageHide();
    this.#pageLifecycleTarget = target;
    target.addEventListener("pagehide", this.#pageHideListener);
    return () => {
      if (this.#pageLifecycleTarget === target) this.unbindPageHide();
    };
  }

  unbindPageHide(): void {
    this.#pageLifecycleTarget?.removeEventListener(
      "pagehide",
      this.#pageHideListener,
    );
    this.#pageLifecycleTarget = null;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.clear();
    this.unbindPageHide();
    this.#vault.dispose();
    if (this.#disposeExecutor) this.#executor.dispose();
    this.#disposed = true;
  }

  snapshot(): WorkflowRunnerSnapshot {
    return Object.freeze({
      activeRunCount: this.#active === null ? 0 : 1,
      generation: this.#generation,
      disposed: this.#disposed,
      run:
        this.#active === null ? this.#lastRun : freezeRunSnapshot(this.#active),
      vault: this.#vault.snapshot(),
      executor: this.#executor.snapshot(),
    });
  }

  async #execute(run: ActiveWorkflowRun): Promise<void> {
    let inputId = run.steps[0]?.inputPayloadId;
    try {
      for (const step of run.plan.steps) {
        if (!this.#isCurrent(run) || inputId === undefined) return;
        const snapshot = run.steps[step.index];
        if (snapshot === undefined) return;

        snapshot.status = "running";
        snapshot.inputPayloadId = inputId;
        run.activeStepIndex = step.index;

        if (
          this.#vault.snapshot().bytes >
          this.#maxResidentBytes - step.workingMemoryBytes
        ) {
          throw new WorkflowError("vault-limit", {
            stepIndex: step.index,
            operationId: step.operationId,
          });
        }

        const input = toOperationInput(this.#vault, inputId);
        const request: OperationRequest = {
          operationId: step.operationId,
          input,
          options: step.options,
        };
        let task: OperationTask;
        try {
          task = this.#executor.execute(request);
        } catch (error) {
          throw canonicalFailure(error, step);
        }
        run.activeTask = task;
        let output: OperationOutput;
        try {
          output = await task.promise;
        } catch (error) {
          if (!this.#isCurrent(run)) return;
          throw canonicalFailure(error, step);
        } finally {
          if (run.activeTask === task) run.activeTask = null;
        }
        if (!this.#isCurrent(run)) return;

        let handle: PayloadHandle;
        try {
          handle = this.#vault.put(output, step.output.contentType);
        } catch (error) {
          throw canonicalVaultFailure(error, step);
        }
        snapshot.status = "succeeded";
        snapshot.outputPayloadId = handle.id;
        inputId = handle.id;
        const next = run.steps[step.index + 1];
        if (next !== undefined) next.inputPayloadId = handle.id;
      }

      if (!this.#isCurrent(run) || inputId === undefined) return;
      run.status = "succeeded";
      run.activeStepIndex = null;
      this.#settleSuccess(run, inputId);
    } catch (error) {
      if (!this.#isCurrent(run)) return;
      const stepIndex = run.activeStepIndex ?? 0;
      const step = run.steps[stepIndex];
      const failure =
        error instanceof WorkflowError
          ? error
          : new WorkflowError(
              "operation-failed",
              "Workflow execution failed.",
              {
                stepIndex,
                operationId: run.plan.steps[stepIndex]?.operationId,
                cause: error,
              },
            );
      if (step !== undefined) {
        step.status = failure.code === "cancelled" ? "cancelled" : "failed";
        step.errorCode = failure.code;
      }
      run.status = failure.code === "cancelled" ? "cancelled" : "failed";
      run.activeStepIndex = null;
      this.#settleFailure(run, failure);
    }
  }

  #isCurrent(run: ActiveWorkflowRun): boolean {
    return (
      !run.settled &&
      this.#active === run &&
      run.generation === this.#generation
    );
  }

  #settleSuccess(run: ActiveWorkflowRun, finalPayloadId: PayloadId): void {
    if (run.settled) return;
    run.settled = true;
    const snapshot = freezeRunSnapshot(run);
    this.#lastRun = snapshot;
    if (this.#active === run) this.#active = null;
    run.resolve(Object.freeze({ runId: run.runId, finalPayloadId, snapshot }));
  }

  #settleFailure(run: ActiveWorkflowRun, error: WorkflowError): void {
    if (run.settled) return;
    run.settled = true;
    const snapshot = freezeRunSnapshot(run);
    this.#lastRun = snapshot;
    if (this.#active === run) this.#active = null;
    run.reject(error);
  }
}

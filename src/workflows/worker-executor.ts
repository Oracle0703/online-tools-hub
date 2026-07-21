import type {
  OperationManifest,
  OperationOutput,
  OperationRequest,
} from "../operations/contract";
import { getOperationManifest } from "../operations/catalog";
import {
  isOperationError,
  OperationError,
  type OperationErrorCode,
} from "../operations/errors";
import type {
  OperationClock,
  OperationExecutionOptions,
  OperationExecutor,
  OperationExecutorSnapshot,
  OperationPageLifecycleTarget,
  OperationScheduler,
  OperationTask,
  OperationWorkerFactory,
  OperationWorkerLike,
} from "../operations/executor";
import {
  validateOperationOutput,
  validateOperationRequest,
} from "../operations/validation";
import {
  collectTransferableBuffers,
  isOperationWorkerResponseMessage,
  isOperationWorkerTaskId,
  OPERATION_WORKER_PROTOCOL_VERSION,
  type OperationWorkerExecuteMessage,
} from "../operations/worker-protocol";

export const DEFAULT_MAX_ACTIVE_WORKFLOW_OPERATION_MEMORY_BYTES =
  512 * 1024 * 1024;
export const DEFAULT_MAX_ACTIVE_WORKFLOW_OPERATION_TASKS = 4;
export const DEFAULT_MAX_ACTIVE_WORKFLOW_OPERATION_WORKERS = 2;

/**
 * The public surface a Workflow needs from an Operation executor. The full
 * `OperationExecutor` satisfies this interface, so callers can still inject it
 * when main/adaptive execution is intentionally required.
 */
export type WorkflowOperationExecutor = Pick<
  OperationExecutor,
  | "execute"
  | "cancel"
  | "cancelAll"
  | "bindPageHide"
  | "unbindPageHide"
  | "dispose"
  | "snapshot"
>;

export interface WorkerOperationExecutorOptions {
  readonly maxActiveMemoryBytes?: number;
  readonly maxActiveTasks?: number;
  readonly maxActiveWorkers?: number;
  readonly workerFactory?: OperationWorkerFactory;
  readonly scheduler?: OperationScheduler;
  readonly clock?: OperationClock;
  readonly taskIdFactory?: () => string;
  readonly getManifest?: (operationId: string) => OperationManifest | undefined;
}

interface ActiveWorkerOperationTask {
  readonly taskId: string;
  readonly operationId: string;
  readonly manifest: OperationManifest;
  readonly resolve: (output: OperationOutput) => void;
  readonly reject: (error: OperationError) => void;
  readonly releaseResourceReservation: () => void;
  readonly deadline: number;
  readonly timeoutMs: number;
  request: OperationRequest | null;
  worker: OperationWorkerLike | null;
  timeoutHandle: unknown;
  externalSignal?: AbortSignal;
  externalAbortListener?: () => void;
  settled: boolean;
}

let activeWorkflowOperationMemoryBytes = 0;
let activeWorkflowOperationTaskCount = 0;
let activeWorkflowOperationWorkerCount = 0;
let nextTaskSequence = 0;

const browserScheduler: OperationScheduler = {
  setTimeout(callback, timeoutMs) {
    return globalThis.setTimeout(callback, timeoutMs);
  },
  clearTimeout(handle) {
    globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>);
  },
};

const monotonicClock: OperationClock = {
  now() {
    return globalThis.performance?.now() ?? Date.now();
  },
};

function createBrowserWorker(details: {
  readonly operationId: string;
}): OperationWorkerLike {
  if (typeof Worker === "undefined") {
    throw new OperationError(
      "unsupported-environment",
      "This environment does not provide Web Workers.",
      { operationId: details.operationId },
    );
  }

  return new Worker(
    new URL("../workers/operation.worker.ts", import.meta.url),
    {
      type: "module",
      name: "online-tools-workflow-operation",
    },
  ) as unknown as OperationWorkerLike;
}

function defaultTaskIdFactory(): string {
  nextTaskSequence += 1;
  return `workflow-operation-${Date.now().toString(36)}-${nextTaskSequence.toString(36)}`;
}

function assertPositiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
  return value;
}

function reserveActiveResources(
  memoryBytes: number,
  limits: {
    readonly maxMemoryBytes: number;
    readonly maxTasks: number;
    readonly maxWorkers: number;
  },
  operationId: string,
): () => void {
  if (
    memoryBytes >
    limits.maxMemoryBytes - activeWorkflowOperationMemoryBytes
  ) {
    throw new OperationError(
      "memory-budget",
      `Active Workflow Operations would exceed the ${limits.maxMemoryBytes}-byte memory budget.`,
      {
        operationId,
        details: {
          activeBytes: activeWorkflowOperationMemoryBytes,
          requestedBytes: memoryBytes,
          maxBytes: limits.maxMemoryBytes,
        },
      },
    );
  }
  if (activeWorkflowOperationTaskCount >= limits.maxTasks) {
    throw new OperationError(
      "memory-budget",
      `Active Workflow Operations reached the ${limits.maxTasks}-task concurrency limit.`,
      {
        operationId,
        details: {
          activeTasks: activeWorkflowOperationTaskCount,
          maxTasks: limits.maxTasks,
        },
      },
    );
  }
  if (activeWorkflowOperationWorkerCount >= limits.maxWorkers) {
    throw new OperationError(
      "memory-budget",
      `Active Workflow Operations reached the ${limits.maxWorkers}-Worker concurrency limit.`,
      {
        operationId,
        details: {
          activeWorkers: activeWorkflowOperationWorkerCount,
          maxWorkers: limits.maxWorkers,
        },
      },
    );
  }

  activeWorkflowOperationMemoryBytes += memoryBytes;
  activeWorkflowOperationTaskCount += 1;
  activeWorkflowOperationWorkerCount += 1;
  let released = false;

  return () => {
    if (released) return;
    released = true;
    activeWorkflowOperationMemoryBytes = Math.max(
      0,
      activeWorkflowOperationMemoryBytes - memoryBytes,
    );
    activeWorkflowOperationTaskCount = Math.max(
      0,
      activeWorkflowOperationTaskCount - 1,
    );
    activeWorkflowOperationWorkerCount = Math.max(
      0,
      activeWorkflowOperationWorkerCount - 1,
    );
  };
}

/**
 * Workflow-default Operation executor. Every accepted request crosses the
 * dedicated one-task Worker boundary, even when its public manifest normally
 * selects main or adaptive execution. This keeps executable adapters out of
 * the page realm while preserving the regular executor contract for callers.
 */
export class WorkerOperationExecutor implements WorkflowOperationExecutor {
  readonly #maxActiveMemoryBytes: number;
  readonly #maxActiveTasks: number;
  readonly #maxActiveWorkers: number;
  readonly #workerFactory: OperationWorkerFactory;
  readonly #scheduler: OperationScheduler;
  readonly #clock: OperationClock;
  readonly #taskIdFactory: () => string;
  readonly #manifestResolver: (
    operationId: string,
  ) => OperationManifest | undefined;
  readonly #tasks = new Map<string, ActiveWorkerOperationTask>();
  #pageLifecycleTarget: OperationPageLifecycleTarget | null = null;
  #disposed = false;

  readonly #pageHideListener = () => {
    this.cancelAll();
  };

  constructor(options: WorkerOperationExecutorOptions = {}) {
    this.#maxActiveMemoryBytes = assertPositiveSafeInteger(
      options.maxActiveMemoryBytes ??
        DEFAULT_MAX_ACTIVE_WORKFLOW_OPERATION_MEMORY_BYTES,
      "maxActiveMemoryBytes",
    );
    this.#maxActiveTasks = assertPositiveSafeInteger(
      options.maxActiveTasks ?? DEFAULT_MAX_ACTIVE_WORKFLOW_OPERATION_TASKS,
      "maxActiveTasks",
    );
    const maxActiveWorkers =
      options.maxActiveWorkers ?? DEFAULT_MAX_ACTIVE_WORKFLOW_OPERATION_WORKERS;
    if (!Number.isSafeInteger(maxActiveWorkers) || maxActiveWorkers < 0) {
      throw new RangeError(
        "maxActiveWorkers must be a non-negative safe integer.",
      );
    }
    this.#maxActiveWorkers = maxActiveWorkers;
    this.#workerFactory = options.workerFactory ?? createBrowserWorker;
    this.#scheduler = options.scheduler ?? browserScheduler;
    this.#clock = options.clock ?? monotonicClock;
    this.#taskIdFactory = options.taskIdFactory ?? defaultTaskIdFactory;
    this.#manifestResolver = options.getManifest ?? getOperationManifest;
  }

  execute(
    request: OperationRequest,
    options: OperationExecutionOptions = {},
  ): OperationTask {
    const requestedOperationId = readOperationIdForLookup(request);
    if (this.#disposed) {
      throw new OperationError(
        "cancelled",
        "The Workflow Operation executor has been disposed.",
      );
    }

    const manifest =
      requestedOperationId === undefined
        ? undefined
        : this.#manifestResolver(requestedOperationId);
    const sourceValidation = validateOperationRequest(manifest, request);
    if (!sourceValidation.ok) throw sourceValidation.error;
    if (manifest === undefined) {
      throw new OperationError(
        "unknown-operation",
        "Operation is not registered.",
      );
    }
    if (options.signal?.aborted) {
      throw new OperationError("cancelled", "Operation was cancelled.", {
        operationId: manifest.id,
      });
    }

    const timeoutMs = resolveTimeout(manifest, options.timeoutMs);
    const deadline = this.#readClock() + timeoutMs;
    if (!Number.isFinite(deadline)) {
      throw new RangeError("Operation deadline must be finite.");
    }

    let taskId = this.#taskIdFactory();
    if (!isOperationWorkerTaskId(taskId)) {
      throw new TypeError(
        "taskIdFactory must return a protocol-safe, non-empty task ID.",
      );
    }
    while (this.#tasks.has(taskId)) taskId = defaultTaskIdFactory();

    const releaseResourceReservation = reserveActiveResources(
      manifest.workingMemoryBytes,
      {
        maxMemoryBytes: this.#maxActiveMemoryBytes,
        maxTasks: this.#maxActiveTasks,
        maxWorkers: this.#maxActiveWorkers,
      },
      manifest.id,
    );

    let requestSnapshot: OperationRequest;
    try {
      requestSnapshot = cloneOperationRequestSnapshot(
        manifest,
        sourceValidation.value,
      );
    } catch (error) {
      releaseResourceReservation();
      throw error;
    }

    let resolvePromise!: (output: OperationOutput) => void;
    let rejectPromise!: (error: OperationError) => void;
    const promise = new Promise<OperationOutput>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const state: ActiveWorkerOperationTask = {
      taskId,
      operationId: manifest.id,
      manifest,
      resolve: resolvePromise,
      reject: rejectPromise,
      releaseResourceReservation,
      deadline,
      timeoutMs,
      request: requestSnapshot,
      worker: null,
      timeoutHandle: undefined,
      externalSignal: options.signal,
      settled: false,
    };
    this.#tasks.set(taskId, state);
    const task: OperationTask = Object.freeze({
      taskId,
      location: "worker" as const,
      promise,
      cancel: () => this.cancel(taskId),
    });

    try {
      const delay = Math.max(0, deadline - this.#readClock());
      state.timeoutHandle = this.#scheduler.setTimeout(
        () => this.#finishFailure(state, this.#createTimeoutError(state)),
        delay,
      );
      if (this.#deadlineReached(state)) {
        this.#finishFailure(state, this.#createTimeoutError(state));
        return task;
      }
    } catch (error) {
      this.#finishFailure(
        state,
        normalizeOperationFailure(error, state.operationId),
      );
      return task;
    }

    if (options.signal !== undefined) {
      try {
        state.externalAbortListener = () => this.cancel(taskId);
        options.signal.addEventListener("abort", state.externalAbortListener, {
          once: true,
        });
        if (options.signal.aborted) this.cancel(taskId);
      } catch (error) {
        this.#finishFailure(
          state,
          normalizeOperationFailure(error, state.operationId),
        );
        return task;
      }
    }

    if (!state.settled) this.#startWorker(state);
    return task;
  }

  cancel(taskId: string): boolean {
    const state = this.#tasks.get(taskId);
    if (state === undefined || state.settled) return false;
    this.#finishFailure(
      state,
      new OperationError("cancelled", "Operation was cancelled.", {
        operationId: state.operationId,
      }),
    );
    return true;
  }

  cancelAll(): number {
    let cancelled = 0;
    for (const taskId of [...this.#tasks.keys()]) {
      if (this.cancel(taskId)) cancelled += 1;
    }
    return cancelled;
  }

  bindPageHide(target: OperationPageLifecycleTarget): () => void {
    if (this.#disposed) {
      throw new OperationError(
        "cancelled",
        "The Workflow Operation executor has been disposed.",
      );
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
    this.#disposed = true;
    this.cancelAll();
    this.unbindPageHide();
  }

  snapshot(): OperationExecutorSnapshot {
    return Object.freeze({
      activeTaskCount: this.#tasks.size,
      activeWorkerCount: this.#tasks.size,
      activeMemoryBytes: activeWorkflowOperationMemoryBytes,
      globalActiveTaskCount: activeWorkflowOperationTaskCount,
      globalActiveWorkerCount: activeWorkflowOperationWorkerCount,
      disposed: this.#disposed,
    });
  }

  #startWorker(state: ActiveWorkerOperationTask): void {
    try {
      const request = state.request;
      if (request === null) return;
      const worker = this.#workerFactory({
        taskId: state.taskId,
        operationId: state.operationId,
      });
      state.worker = worker;

      worker.onmessage = (event) => {
        if (state.settled) return;
        const message = event.data;
        if (
          !isOperationWorkerResponseMessage(message) ||
          message.taskId !== state.taskId
        ) {
          this.#finishFailure(
            state,
            new OperationError(
              "worker-crashed",
              "Operation Worker returned an invalid protocol message.",
              { operationId: state.operationId },
            ),
          );
          return;
        }

        if (message.type === "failure") {
          this.#finishFailure(
            state,
            new OperationError(
              message.error.code,
              canonicalWorkerFailureMessage(message.error.code),
              { operationId: state.operationId },
            ),
          );
          return;
        }

        const validation = validateOperationOutput(
          state.manifest,
          message.output,
        );
        if (!validation.ok) {
          this.#finishFailure(state, validation.error);
          return;
        }
        this.#finishSuccess(state, validation.value);
      };
      worker.onerror = (event) => {
        event.preventDefault?.();
        this.#finishFailure(
          state,
          new OperationError("worker-crashed", "Operation Worker crashed.", {
            operationId: state.operationId,
          }),
        );
      };
      worker.onmessageerror = () => {
        this.#finishFailure(
          state,
          new OperationError(
            "worker-crashed",
            "Operation Worker could not deserialize a message.",
            { operationId: state.operationId },
          ),
        );
      };

      const message: OperationWorkerExecuteMessage = {
        version: OPERATION_WORKER_PROTOCOL_VERSION,
        type: "execute",
        taskId: state.taskId,
        request,
      };
      worker.postMessage(message, collectTransferableBuffers(request));
      state.request = null;
    } catch (error) {
      this.#finishFailure(
        state,
        normalizeWorkerFailure(error, state.operationId),
      );
    }
  }

  #finishSuccess(
    state: ActiveWorkerOperationTask,
    output: OperationOutput,
  ): void {
    if (state.settled) return;
    try {
      if (this.#deadlineReached(state)) {
        this.#finishFailure(state, this.#createTimeoutError(state));
        return;
      }
    } catch (error) {
      this.#finishFailure(
        state,
        normalizeOperationFailure(error, state.operationId),
      );
      return;
    }
    state.settled = true;
    this.#cleanup(state);
    state.resolve(output);
  }

  #deadlineReached(state: ActiveWorkerOperationTask): boolean {
    return this.#readClock() >= state.deadline;
  }

  #readClock(): number {
    const now = this.#clock.now();
    if (!Number.isFinite(now)) {
      throw new RangeError("Operation clock must return a finite timestamp.");
    }
    return now;
  }

  #createTimeoutError(state: ActiveWorkerOperationTask): OperationError {
    return new OperationError(
      "timeout",
      `Operation exceeded its ${state.timeoutMs} ms timeout.`,
      { operationId: state.operationId },
    );
  }

  #finishFailure(
    state: ActiveWorkerOperationTask,
    error: OperationError,
  ): void {
    if (state.settled) return;
    state.settled = true;
    this.#cleanup(state);
    state.reject(error);
  }

  #cleanup(state: ActiveWorkerOperationTask): void {
    if (state.timeoutHandle !== undefined) {
      try {
        this.#scheduler.clearTimeout(state.timeoutHandle);
      } catch {
        // Scheduler failures must not retain task payloads or reservations.
      }
    }
    if (
      state.externalSignal !== undefined &&
      state.externalAbortListener !== undefined
    ) {
      try {
        state.externalSignal.removeEventListener(
          "abort",
          state.externalAbortListener,
        );
      } catch {
        // Partial AbortSignal shims must not block final cleanup.
      }
    }

    const worker = state.worker;
    state.worker = null;
    if (worker !== null) {
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      try {
        worker.terminate();
      } catch {
        // Logical cleanup is mandatory even when host termination throws.
      }
    }

    state.request = null;
    state.releaseResourceReservation();
    this.#tasks.delete(state.taskId);
  }
}

function canonicalWorkerFailureMessage(code: OperationErrorCode): string {
  switch (code) {
    case "unknown-operation":
      return "Operation is not registered.";
    case "type-mismatch":
      return "Operation input or output has an unsupported type.";
    case "input-too-large":
      return "Operation input exceeds its size limit.";
    case "output-too-large":
      return "Operation output exceeds its size limit.";
    case "memory-budget":
      return "Operation exceeded its working-memory budget.";
    case "invalid-options":
      return "Operation options are invalid.";
    case "timeout":
      return "Operation timed out.";
    case "cancelled":
      return "Operation was cancelled.";
    case "worker-crashed":
      return "Operation Worker crashed.";
    case "unsupported-environment":
      return "Operation requires an unavailable browser capability.";
    case "execution-failed":
      return "Operation execution failed.";
  }
}

function cloneOperationRequestSnapshot(
  manifest: OperationManifest,
  request: OperationRequest,
): OperationRequest {
  let snapshot: unknown;
  try {
    snapshot = structuredClone(request);
  } catch (error) {
    throw new OperationError(
      "type-mismatch",
      "Operation request could not be copied into a data-only snapshot.",
      { operationId: manifest.id, cause: error },
    );
  }
  const validation = validateOperationRequest(manifest, snapshot);
  if (!validation.ok) throw validation.error;
  return validation.value;
}

function readOperationIdForLookup(value: unknown): string | undefined {
  if (value === null || typeof value !== "object") return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, "operationId");
    return descriptor !== undefined &&
      "value" in descriptor &&
      typeof descriptor.value === "string"
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

function resolveTimeout(
  manifest: OperationManifest,
  override: number | undefined,
): number {
  if (override === undefined) return manifest.execution.timeoutMs;
  if (!Number.isSafeInteger(override) || override <= 0) {
    throw new RangeError("timeoutMs must be a positive safe integer.");
  }
  return Math.min(override, manifest.execution.timeoutMs);
}

function normalizeOperationFailure(
  error: unknown,
  operationId: string,
): OperationError {
  if (isOperationError(error)) return error;
  return new OperationError("execution-failed", "Operation execution failed.", {
    operationId,
    cause: error,
  });
}

function normalizeWorkerFailure(
  error: unknown,
  operationId: string,
): OperationError {
  if (isOperationError(error)) return error;
  return new OperationError(
    "worker-crashed",
    "Operation Worker could not be started.",
    { operationId, cause: error },
  );
}

import type {
  OperationDefinition,
  OperationExecutionContext,
  OperationExecutionLocation,
  OperationManifest,
  OperationOutput,
  OperationRequest,
} from "./contract";
import {
  isOperationError,
  OperationError,
  type OperationErrorCode,
} from "./errors";
import { getOperationManifest } from "./catalog";
import { loadOperationDefinition } from "./runtime-registry";
import {
  assertWorkingMemoryWithinBudget,
  payloadByteLength,
  validateOperationOutput,
  validateOperationRequest,
} from "./validation";
import {
  collectTransferableBuffers,
  isOperationWorkerResponseMessage,
  isOperationWorkerTaskId,
  OPERATION_WORKER_PROTOCOL_VERSION,
  type OperationWorkerExecuteMessage,
} from "./worker-protocol";

export const DEFAULT_ADAPTIVE_WORKER_THRESHOLD_BYTES = 128 * 1024;
export const DEFAULT_MAX_ACTIVE_OPERATION_MEMORY_BYTES = 512 * 1024 * 1024;
export const DEFAULT_MAX_ACTIVE_OPERATION_TASKS = 4;
export const DEFAULT_MAX_ACTIVE_OPERATION_WORKERS = 2;

let activeOperationMemoryBytes = 0;
let activeOperationTaskCount = 0;
let activeOperationWorkerCount = 0;
let nextTaskSequence = 0;

export interface OperationWorkerMessageEvent {
  readonly data: unknown;
}

export interface OperationWorkerErrorEvent {
  readonly error?: unknown;
  readonly message?: string;
  preventDefault?(): void;
}

/** The narrow Worker surface used by the executor and by deterministic tests. */
export interface OperationWorkerLike {
  onmessage: ((event: OperationWorkerMessageEvent) => void) | null;
  onerror: ((event: OperationWorkerErrorEvent) => void) | null;
  onmessageerror: ((event: OperationWorkerMessageEvent) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
}

export type OperationWorkerFactory = (details: {
  readonly taskId: string;
  readonly operationId: string;
}) => OperationWorkerLike;

export interface OperationScheduler {
  setTimeout(callback: () => void, timeoutMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface OperationClock {
  now(): number;
}

export interface OperationPageLifecycleTarget {
  addEventListener(type: "pagehide", listener: () => void): void;
  removeEventListener(type: "pagehide", listener: () => void): void;
}

export interface OperationExecutionOptions {
  /** May shorten, but never extend, the manifest timeout. */
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface OperationTask {
  readonly taskId: string;
  readonly location: OperationExecutionLocation;
  readonly promise: Promise<OperationOutput>;
  /** Synchronously aborts and, for Worker tasks, terminates the Worker. */
  cancel(): boolean;
}

export interface OperationExecutorSnapshot {
  readonly activeTaskCount: number;
  readonly activeWorkerCount: number;
  readonly activeMemoryBytes: number;
  readonly globalActiveTaskCount: number;
  readonly globalActiveWorkerCount: number;
  readonly disposed: boolean;
}

export interface OperationExecutorOptions {
  readonly maxActiveMemoryBytes?: number;
  readonly maxActiveTasks?: number;
  readonly maxActiveWorkers?: number;
  readonly workerFactory?: OperationWorkerFactory;
  readonly scheduler?: OperationScheduler;
  readonly clock?: OperationClock;
  readonly taskIdFactory?: () => string;
  readonly getManifest?: (operationId: string) => OperationManifest | undefined;
  readonly loadDefinition?: (
    operationId: string,
  ) => Promise<OperationDefinition>;
}

interface ActiveOperationTask {
  readonly taskId: string;
  readonly operationId: string;
  readonly manifest: OperationManifest;
  readonly location: OperationExecutionLocation;
  readonly controller: AbortController;
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
    { type: "module", name: "online-tools-operation" },
  ) as unknown as OperationWorkerLike;
}

function defaultTaskIdFactory(): string {
  nextTaskSequence += 1;
  return `operation-${Date.now().toString(36)}-${nextTaskSequence.toString(36)}`;
}

function reserveActiveResources(
  memoryBytes: number,
  location: OperationExecutionLocation,
  limits: {
    readonly maxMemoryBytes: number;
    readonly maxTasks: number;
    readonly maxWorkers: number;
  },
  operationId: string,
): () => void {
  if (memoryBytes > limits.maxMemoryBytes - activeOperationMemoryBytes) {
    throw new OperationError(
      "memory-budget",
      `Active Operations would exceed the ${limits.maxMemoryBytes}-byte global memory budget.`,
      {
        operationId,
        details: {
          activeBytes: activeOperationMemoryBytes,
          requestedBytes: memoryBytes,
          maxBytes: limits.maxMemoryBytes,
        },
      },
    );
  }
  if (activeOperationTaskCount >= limits.maxTasks) {
    throw new OperationError(
      "memory-budget",
      `Active Operations reached the ${limits.maxTasks}-task concurrency limit.`,
      {
        operationId,
        details: {
          activeTasks: activeOperationTaskCount,
          maxTasks: limits.maxTasks,
        },
      },
    );
  }
  if (
    location === "worker" &&
    activeOperationWorkerCount >= limits.maxWorkers
  ) {
    throw new OperationError(
      "memory-budget",
      `Active Operations reached the ${limits.maxWorkers}-Worker concurrency limit.`,
      {
        operationId,
        details: {
          activeWorkers: activeOperationWorkerCount,
          maxWorkers: limits.maxWorkers,
        },
      },
    );
  }

  activeOperationMemoryBytes += memoryBytes;
  activeOperationTaskCount += 1;
  if (location === "worker") activeOperationWorkerCount += 1;
  let released = false;

  return () => {
    if (released) return;
    released = true;
    activeOperationMemoryBytes = Math.max(
      0,
      activeOperationMemoryBytes - memoryBytes,
    );
    activeOperationTaskCount = Math.max(0, activeOperationTaskCount - 1);
    if (location === "worker") {
      activeOperationWorkerCount = Math.max(0, activeOperationWorkerCount - 1);
    }
  };
}

export function getActiveOperationMemoryBytes(): number {
  return activeOperationMemoryBytes;
}

export function getActiveOperationTaskCount(): number {
  return activeOperationTaskCount;
}

export function getActiveOperationWorkerCount(): number {
  return activeOperationWorkerCount;
}

export class OperationExecutor {
  private readonly maxActiveMemoryBytes: number;
  private readonly maxActiveTasks: number;
  private readonly maxActiveWorkers: number;
  private readonly workerFactory: OperationWorkerFactory;
  private readonly scheduler: OperationScheduler;
  private readonly clock: OperationClock;
  private readonly taskIdFactory: () => string;
  private readonly manifestResolver: (
    operationId: string,
  ) => OperationManifest | undefined;
  private readonly definitionLoader: (
    operationId: string,
  ) => Promise<OperationDefinition>;
  private readonly tasks = new Map<string, ActiveOperationTask>();
  private pageLifecycleTarget: OperationPageLifecycleTarget | null = null;
  private disposed = false;

  private readonly pageHideListener = () => {
    this.cancelAll();
  };

  constructor(options: OperationExecutorOptions = {}) {
    const maxActiveMemoryBytes =
      options.maxActiveMemoryBytes ?? DEFAULT_MAX_ACTIVE_OPERATION_MEMORY_BYTES;
    const maxActiveTasks =
      options.maxActiveTasks ?? DEFAULT_MAX_ACTIVE_OPERATION_TASKS;
    const maxActiveWorkers =
      options.maxActiveWorkers ?? DEFAULT_MAX_ACTIVE_OPERATION_WORKERS;
    if (
      !Number.isSafeInteger(maxActiveMemoryBytes) ||
      maxActiveMemoryBytes <= 0
    ) {
      throw new RangeError(
        "maxActiveMemoryBytes must be a positive safe integer.",
      );
    }
    if (!Number.isSafeInteger(maxActiveTasks) || maxActiveTasks <= 0) {
      throw new RangeError("maxActiveTasks must be a positive safe integer.");
    }
    if (!Number.isSafeInteger(maxActiveWorkers) || maxActiveWorkers < 0) {
      throw new RangeError(
        "maxActiveWorkers must be a non-negative safe integer.",
      );
    }

    this.maxActiveMemoryBytes = maxActiveMemoryBytes;
    this.maxActiveTasks = maxActiveTasks;
    this.maxActiveWorkers = maxActiveWorkers;
    this.workerFactory = options.workerFactory ?? createBrowserWorker;
    this.scheduler = options.scheduler ?? browserScheduler;
    this.clock = options.clock ?? monotonicClock;
    this.taskIdFactory = options.taskIdFactory ?? defaultTaskIdFactory;
    this.manifestResolver = options.getManifest ?? getOperationManifest;
    this.definitionLoader = options.loadDefinition ?? loadOperationDefinition;
  }

  execute(
    request: OperationRequest,
    options: OperationExecutionOptions = {},
  ): OperationTask {
    const requestedOperationId = readOperationIdForLookup(request);
    if (this.disposed) {
      throw new OperationError(
        "cancelled",
        "The Operation executor has been disposed.",
      );
    }

    const manifest =
      requestedOperationId === undefined
        ? undefined
        : this.manifestResolver(requestedOperationId);
    const sourceValidation = validateOperationRequest(manifest, request);
    if (!sourceValidation.ok) throw sourceValidation.error;
    if (manifest === undefined) {
      // `validateOperationRequest` already reports this branch; keep the
      // invariant explicit for TypeScript and injected validators/catalogs.
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

    const inputBytes = payloadByteLength(sourceValidation.value.input);
    const location = resolveExecutionLocation(manifest, inputBytes);
    const timeoutMs = resolveTimeout(manifest, options.timeoutMs);
    const startedAt = this.clock.now();
    if (!Number.isFinite(startedAt)) {
      throw new RangeError("Operation clock must return a finite timestamp.");
    }
    const deadline = startedAt + timeoutMs;
    if (!Number.isFinite(deadline)) {
      throw new RangeError("Operation deadline must be finite.");
    }

    let taskId = this.taskIdFactory();
    if (!isOperationWorkerTaskId(taskId)) {
      throw new TypeError(
        "taskIdFactory must return a protocol-safe, non-empty task ID.",
      );
    }
    while (this.tasks.has(taskId)) taskId = defaultTaskIdFactory();

    const releaseResourceReservation = reserveActiveResources(
      manifest.workingMemoryBytes,
      location,
      {
        maxMemoryBytes: this.maxActiveMemoryBytes,
        maxTasks: this.maxActiveTasks,
        maxWorkers: this.maxActiveWorkers,
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
    const state: ActiveOperationTask = {
      taskId,
      operationId: manifest.id,
      manifest,
      location,
      controller: new AbortController(),
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
    this.tasks.set(taskId, state);

    const task: OperationTask = {
      taskId,
      location,
      promise,
      cancel: () => this.cancel(taskId),
    };

    try {
      state.timeoutHandle = this.scheduler.setTimeout(
        () => {
          this.finishFailure(state, this.createTimeoutError(state));
        },
        Math.max(0, deadline - this.clock.now()),
      );
    } catch (error) {
      this.finishFailure(
        state,
        normalizeOperationFailure(error, state.operationId),
      );
      return task;
    }

    try {
      if (this.deadlineReached(state)) {
        this.finishFailure(state, this.createTimeoutError(state));
        return task;
      }
    } catch (error) {
      this.finishFailure(
        state,
        normalizeOperationFailure(error, state.operationId),
      );
      return task;
    }

    if (options.signal !== undefined) {
      try {
        state.externalAbortListener = () => {
          this.cancel(taskId);
        };
        options.signal.addEventListener("abort", state.externalAbortListener, {
          once: true,
        });
        if (options.signal.aborted) this.cancel(taskId);
      } catch (error) {
        this.finishFailure(
          state,
          normalizeOperationFailure(error, state.operationId),
        );
        return task;
      }
    }

    if (!state.settled) {
      if (location === "worker") this.startWorker(state);
      else void this.startMain(state);
    }

    return task;
  }

  cancel(taskId: string): boolean {
    const state = this.tasks.get(taskId);
    if (state === undefined || state.settled) return false;

    this.finishFailure(
      state,
      new OperationError("cancelled", "Operation was cancelled.", {
        operationId: state.operationId,
      }),
    );
    return true;
  }

  cancelAll(): number {
    const taskIds = [...this.tasks.keys()];
    let cancelled = 0;
    for (const taskId of taskIds) {
      if (this.cancel(taskId)) cancelled += 1;
    }
    return cancelled;
  }

  /** Explicitly opts this executor into page lifecycle cancellation. */
  bindPageHide(target: OperationPageLifecycleTarget): () => void {
    if (this.disposed) {
      throw new OperationError(
        "cancelled",
        "The Operation executor has been disposed.",
      );
    }

    this.unbindPageHide();
    this.pageLifecycleTarget = target;
    target.addEventListener("pagehide", this.pageHideListener);
    return () => {
      if (this.pageLifecycleTarget === target) this.unbindPageHide();
    };
  }

  unbindPageHide(): void {
    this.pageLifecycleTarget?.removeEventListener(
      "pagehide",
      this.pageHideListener,
    );
    this.pageLifecycleTarget = null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelAll();
    this.unbindPageHide();
  }

  snapshot(): OperationExecutorSnapshot {
    return {
      activeTaskCount: this.tasks.size,
      activeWorkerCount: [...this.tasks.values()].filter(
        (task) => task.location === "worker",
      ).length,
      activeMemoryBytes: activeOperationMemoryBytes,
      globalActiveTaskCount: activeOperationTaskCount,
      globalActiveWorkerCount: activeOperationWorkerCount,
      disposed: this.disposed,
    };
  }

  private async startMain(state: ActiveOperationTask): Promise<void> {
    try {
      const definition = await this.definitionLoader(state.operationId);
      if (state.settled) return;
      this.assertDefinitionMatchesManifest(definition, state.manifest);
      if (this.deadlineReached(state)) {
        this.finishFailure(state, this.createTimeoutError(state));
        return;
      }

      const request = state.request;
      if (request === null) return;
      const output = await definition.execute(
        request.input,
        request.options ?? {},
        this.createExecutionContext(state),
      );
      if (state.settled) return;

      const validation = validateOperationOutput(state.manifest, output);
      if (!validation.ok) throw validation.error;
      this.finishSuccess(state, validation.value);
    } catch (error) {
      if (!state.settled) {
        this.finishFailure(
          state,
          normalizeOperationFailure(error, state.operationId),
        );
      }
    }
  }

  private startWorker(state: ActiveOperationTask): void {
    try {
      const request = state.request;
      if (request === null) return;
      const worker = this.workerFactory({
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
          this.finishFailure(
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
          this.finishFailure(
            state,
            new OperationError(
              message.error.code,
              canonicalWorkerFailureMessage(message.error.code),
              {
                operationId: state.operationId,
              },
            ),
          );
          return;
        }

        const validation = validateOperationOutput(
          state.manifest,
          message.output,
        );
        if (!validation.ok) {
          this.finishFailure(state, validation.error);
          return;
        }
        this.finishSuccess(state, validation.value);
      };
      worker.onerror = (event) => {
        event.preventDefault?.();
        this.finishFailure(
          state,
          new OperationError("worker-crashed", "Operation Worker crashed.", {
            operationId: state.operationId,
          }),
        );
      };
      worker.onmessageerror = () => {
        this.finishFailure(
          state,
          new OperationError(
            "worker-crashed",
            "Operation Worker could not deserialize a message.",
            { operationId: state.operationId },
          ),
        );
      };

      const transfer = collectTransferableBuffers(request);
      const message: OperationWorkerExecuteMessage = {
        version: OPERATION_WORKER_PROTOCOL_VERSION,
        type: "execute",
        taskId: state.taskId,
        request,
      };
      // `request` is already the executor-owned admission snapshot, so it can
      // move directly without a second full-size clone. Caller buffers remain
      // untouched while this snapshot is detached at the Worker boundary.
      worker.postMessage(message, transfer);
      state.request = null;
    } catch (error) {
      this.finishFailure(
        state,
        normalizeWorkerFailure(error, state.operationId),
      );
    }
  }

  private createExecutionContext(
    state: ActiveOperationTask,
  ): OperationExecutionContext {
    return {
      signal: state.controller.signal,
      location: "main",
      checkCancelled: () => {
        if (state.controller.signal.aborted) {
          throw new OperationError("cancelled", "Operation was cancelled.", {
            operationId: state.operationId,
          });
        }
      },
      assertWorkingMemory: (bytes) => {
        assertWorkingMemoryWithinBudget(state.manifest, bytes);
      },
    };
  }

  private assertDefinitionMatchesManifest(
    definition: OperationDefinition,
    manifest: OperationManifest,
  ): void {
    if (definition.manifest.id !== manifest.id) {
      throw new OperationError(
        "execution-failed",
        "The loaded Operation definition does not match its catalog manifest.",
        { operationId: manifest.id },
      );
    }
  }

  private finishSuccess(
    state: ActiveOperationTask,
    output: OperationOutput,
  ): void {
    if (state.settled) return;
    try {
      if (this.deadlineReached(state)) {
        this.finishFailure(state, this.createTimeoutError(state));
        return;
      }
    } catch (error) {
      this.finishFailure(
        state,
        normalizeOperationFailure(error, state.operationId),
      );
      return;
    }
    state.settled = true;
    this.cleanup(state);
    state.resolve(output);
  }

  private deadlineReached(state: ActiveOperationTask): boolean {
    return this.clock.now() >= state.deadline;
  }

  private createTimeoutError(state: ActiveOperationTask): OperationError {
    return new OperationError(
      "timeout",
      `Operation exceeded its ${state.timeoutMs} ms timeout.`,
      { operationId: state.operationId },
    );
  }

  private finishFailure(
    state: ActiveOperationTask,
    error: OperationError,
  ): void {
    if (state.settled) return;
    state.settled = true;
    state.controller.abort(error);
    this.cleanup(state);
    state.reject(error);
  }

  private cleanup(state: ActiveOperationTask): void {
    if (state.timeoutHandle !== undefined) {
      try {
        this.scheduler.clearTimeout(state.timeoutHandle);
      } catch {
        // A host scheduler failure must not retain task payloads or budgets.
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
        // Hostile or partial AbortSignal shims must not block final cleanup.
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
        // Termination is best-effort at the browser boundary; logical memory
        // reservations and task references must still be released below.
      }
    }

    state.request = null;
    state.releaseResourceReservation();
    this.tasks.delete(state.taskId);
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

function resolveExecutionLocation(
  manifest: OperationManifest,
  inputBytes: number,
): OperationExecutionLocation {
  const strategy = manifest.execution.strategy;
  if (strategy === "main") return "main";
  if (strategy === "worker") return "worker";
  if (strategy !== "adaptive") {
    throw new TypeError(
      `Unsupported execution strategy '${String(strategy)}'.`,
    );
  }

  const configuredThreshold = manifest.execution.workerThresholdBytes;
  const threshold =
    configuredThreshold === null || configuredThreshold === 0
      ? DEFAULT_ADAPTIVE_WORKER_THRESHOLD_BYTES
      : configuredThreshold;
  return inputBytes >= threshold ? "worker" : "main";
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
      { operationId: manifest?.id, cause: error },
    );
  }

  // Validate the clone again so every later phase uses one stable, normalized
  // snapshot rather than caller-owned objects that can change after admission.
  const snapshotValidation = validateOperationRequest(manifest, snapshot);
  if (!snapshotValidation.ok) throw snapshotValidation.error;
  return snapshotValidation.value;
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

import type {
  OperationExecutionLocation,
  OperationOutput,
  OperationRequest,
} from "../operations/contract";
import type { SerializedOperationError } from "../operations/errors";
import { isOperationError } from "../operations/errors";
import {
  OperationExecutor,
  type OperationExecutorSnapshot,
} from "../operations/executor";

const MAX_PENDING_PROBE_RESULTS = 4;

export type OperationRuntimeProbeOutput =
  | Readonly<{ kind: "text"; text: string }>
  | Readonly<{
      kind: "binary";
      byteLength: number;
      mimeType?: string;
    }>;

export type OperationRuntimeProbeResult =
  | Readonly<{ ok: true; output: OperationRuntimeProbeOutput }>
  | Readonly<{ ok: false; error: SerializedOperationError }>;

export interface OperationRuntimeProbeStart {
  readonly taskId: string;
  readonly location: OperationExecutionLocation;
}

export interface OperationRuntimeProbeSnapshot extends OperationExecutorSnapshot {
  readonly pendingResultCount: number;
}

/**
 * Narrow browser-only acceptance surface for the hidden production runtime
 * route. It accepts the same local-data request contract as OperationExecutor
 * and deliberately exposes no dynamic module, callback, URL or network input.
 */
export interface OperationRuntimeProbe {
  start(request: OperationRequest): OperationRuntimeProbeStart;
  wait(taskId: string): Promise<OperationRuntimeProbeResult>;
  cancel(taskId: string): boolean;
  snapshot(): OperationRuntimeProbeSnapshot;
}

interface PendingProbeTask {
  cancel: (() => boolean) | null;
  readonly result: Promise<OperationRuntimeProbeResult>;
}

type OperationRuntimeProbeWindow = Window &
  typeof globalThis & {
    readonly __onlineToolsOperationProbe?: OperationRuntimeProbe;
  };

const executor = new OperationExecutor();
const pendingTasks = new Map<string, PendingProbeTask>();

executor.bindPageHide(window);

function summarizeOutput(output: OperationOutput): OperationRuntimeProbeOutput {
  if (output.kind === "text") {
    return Object.freeze({ kind: "text", text: output.text });
  }

  return Object.freeze({
    kind: "binary",
    byteLength: output.data.byteLength,
    ...(output.mimeType === undefined ? {} : { mimeType: output.mimeType }),
  });
}

function serializeProbeFailure(error: unknown): SerializedOperationError {
  if (isOperationError(error)) return error.toJSON();

  return {
    name: "OperationError",
    code: "execution-failed",
    message: "Operation execution failed.",
  };
}

function validateTaskId(taskId: string): void {
  if (typeof taskId !== "string" || taskId.length === 0) {
    throw new TypeError("Operation probe taskId must be a non-empty string.");
  }
}

const probe: OperationRuntimeProbe = Object.freeze({
  start(request: OperationRequest): OperationRuntimeProbeStart {
    if (pendingTasks.size >= MAX_PENDING_PROBE_RESULTS) {
      throw new RangeError("Operation probe has too many unread results.");
    }

    const task = executor.execute(request);
    const result = task.promise.then<
      OperationRuntimeProbeResult,
      OperationRuntimeProbeResult
    >(
      (output) => Object.freeze({ ok: true, output: summarizeOutput(output) }),
      (error: unknown) =>
        Object.freeze({ ok: false, error: serializeProbeFailure(error) }),
    );
    const pending: PendingProbeTask = { cancel: task.cancel, result };
    void result.then(() => {
      // Do not retain the resolved OperationTask promise: binary outputs can
      // be large even though the probe result only exposes their byte length.
      pending.cancel = null;
    });
    pendingTasks.set(task.taskId, pending);

    return Object.freeze({ taskId: task.taskId, location: task.location });
  },

  async wait(taskId: string): Promise<OperationRuntimeProbeResult> {
    validateTaskId(taskId);
    const pending = pendingTasks.get(taskId);
    if (pending === undefined) {
      throw new RangeError("Operation probe task was not found.");
    }

    try {
      return await pending.result;
    } finally {
      pendingTasks.delete(taskId);
    }
  },

  cancel(taskId: string): boolean {
    validateTaskId(taskId);
    return pendingTasks.get(taskId)?.cancel?.() ?? false;
  },

  snapshot(): OperationRuntimeProbeSnapshot {
    return Object.freeze({
      ...executor.snapshot(),
      pendingResultCount: pendingTasks.size,
    });
  },
});

Object.defineProperty(
  window as OperationRuntimeProbeWindow,
  "__onlineToolsOperationProbe",
  {
    configurable: false,
    enumerable: false,
    writable: false,
    value: probe,
  },
);
document.documentElement.dataset.operationRuntimeProbe = "ready";
window.dispatchEvent(new Event("operation-runtime-probe-ready"));

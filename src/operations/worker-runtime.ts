import type {
  OperationDefinition,
  OperationExecutionContext,
  OperationManifest,
} from "./contract";
import {
  isOperationError,
  OperationError,
  serializeOperationError,
} from "./errors";
import {
  assertWorkingMemoryWithinBudget,
  validateOperationOutput,
  validateOperationRequest,
} from "./validation";
import {
  collectTransferableBuffers,
  isOperationWorkerExecuteMessage,
  isOperationWorkerTaskId,
  OPERATION_WORKER_PROTOCOL_VERSION,
  type OperationWorkerFailureMessage,
  type OperationWorkerSuccessMessage,
} from "./worker-protocol";

export interface OperationWorkerScope {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

export interface OperationWorkerRuntimeOptions {
  readonly getManifest: (operationId: string) => OperationManifest | undefined;
  readonly loadDefinition: (
    operationId: string,
  ) => Promise<OperationDefinition>;
}

/**
 * Installs the shared, one-task Operation protocol after the entry Worker has
 * established its fail-closed privacy guards.
 */
export function installOperationWorkerRuntime(
  workerScope: OperationWorkerScope,
  options: OperationWorkerRuntimeOptions,
): void {
  let acceptedTask = false;

  workerScope.onmessage = (event) => {
    const candidate = event.data;
    if (!isOperationWorkerExecuteMessage(candidate)) {
      postFailure(
        workerScope,
        readTaskId(candidate),
        new OperationError(
          "execution-failed",
          "Operation Worker received an invalid protocol message.",
        ),
      );
      return;
    }

    if (acceptedTask) {
      postFailure(
        workerScope,
        candidate.taskId,
        new OperationError(
          "execution-failed",
          "An Operation Worker accepts exactly one task.",
        ),
      );
      return;
    }
    acceptedTask = true;

    void executeTask(workerScope, options, candidate.taskId, candidate.request);
  };
}

async function executeTask(
  workerScope: OperationWorkerScope,
  options: OperationWorkerRuntimeOptions,
  taskId: string,
  request: unknown,
): Promise<void> {
  const operationId = readRequestOperationId(request);

  try {
    const manifest =
      operationId === undefined ? undefined : options.getManifest(operationId);
    const requestValidation = validateOperationRequest(manifest, request);
    if (!requestValidation.ok) throw requestValidation.error;
    if (manifest === undefined) {
      throw new OperationError(
        "unknown-operation",
        "Operation is not registered.",
      );
    }

    const definition = await options.loadDefinition(manifest.id);
    if (definition.manifest.id !== manifest.id) {
      throw new OperationError(
        "execution-failed",
        "The loaded Operation definition does not match its catalog manifest.",
        { operationId: manifest.id },
      );
    }

    const controller = new AbortController();
    const output = await definition.execute(
      requestValidation.value.input,
      requestValidation.value.options ?? {},
      createExecutionContext(manifest, controller.signal),
    );

    // Validate again at the isolation boundary before ownership is transferred.
    const outputValidation = validateOperationOutput(manifest, output);
    if (!outputValidation.ok) throw outputValidation.error;

    const message: OperationWorkerSuccessMessage = {
      version: OPERATION_WORKER_PROTOCOL_VERSION,
      type: "success",
      taskId,
      output: outputValidation.value,
    };
    workerScope.postMessage(message, [
      ...collectTransferableBuffers(outputValidation.value),
    ]);
  } catch (error) {
    postFailure(workerScope, taskId, normalizeFailure(error, operationId));
  }
}

function createExecutionContext(
  manifest: OperationManifest,
  signal: AbortSignal,
): OperationExecutionContext {
  return {
    signal,
    location: "worker",
    checkCancelled: () => {
      if (signal.aborted) {
        throw new OperationError("cancelled", "Operation was cancelled.", {
          operationId: manifest.id,
        });
      }
    },
    assertWorkingMemory: (bytes) => {
      assertWorkingMemoryWithinBudget(manifest, bytes);
    },
  };
}

function postFailure(
  workerScope: OperationWorkerScope,
  taskId: string,
  error: OperationError,
): void {
  const message: OperationWorkerFailureMessage = {
    version: OPERATION_WORKER_PROTOCOL_VERSION,
    type: "failure",
    taskId,
    error: serializeOperationError(error),
  };
  workerScope.postMessage(message);
}

function normalizeFailure(
  error: unknown,
  operationId: string | undefined,
): OperationError {
  if (isOperationError(error)) return error;
  return new OperationError("execution-failed", "Operation execution failed.", {
    operationId,
    cause: error,
  });
}

function readTaskId(value: unknown): string {
  if (value !== null && typeof value === "object") {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(value, "taskId");
      if (
        descriptor !== undefined &&
        "value" in descriptor &&
        isOperationWorkerTaskId(descriptor.value)
      ) {
        return descriptor.value;
      }
    } catch {
      // Invalid host objects use the fixed fallback ID below.
    }
  }
  return "invalid-task";
}

function readRequestOperationId(value: unknown): string | undefined {
  if (value !== null && typeof value === "object") {
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
  return undefined;
}

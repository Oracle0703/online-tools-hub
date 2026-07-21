import type { OperationOutput, OperationRequest } from "./contract";
import { operationErrorCodes, type SerializedOperationError } from "./errors";
import { validateOperationOptions } from "./validation";

export const OPERATION_WORKER_PROTOCOL_VERSION = 1 as const;
export const MAX_OPERATION_WORKER_TASK_ID_LENGTH = 128;
export const MAX_OPERATION_WORKER_ERROR_MESSAGE_LENGTH = 1_024;
export const MAX_OPERATION_WORKER_ERROR_DETAILS_BYTES = 8 * 1_024;

const TASK_ID_PATTERN = /^[a-zA-Z0-9._:-]+$/;
const EXECUTE_MESSAGE_KEYS = new Set(["version", "type", "taskId", "request"]);
const SUCCESS_MESSAGE_KEYS = new Set(["version", "type", "taskId", "output"]);
const FAILURE_MESSAGE_KEYS = new Set(["version", "type", "taskId", "error"]);
const ERROR_KEYS = new Set([
  "name",
  "code",
  "message",
  "operationId",
  "details",
]);

export interface OperationWorkerExecuteMessage {
  version: typeof OPERATION_WORKER_PROTOCOL_VERSION;
  type: "execute";
  taskId: string;
  request: OperationRequest;
}

export interface OperationWorkerSuccessMessage {
  version: typeof OPERATION_WORKER_PROTOCOL_VERSION;
  type: "success";
  taskId: string;
  output: OperationOutput;
}

export interface OperationWorkerFailureMessage {
  version: typeof OPERATION_WORKER_PROTOCOL_VERSION;
  type: "failure";
  taskId: string;
  error: SerializedOperationError;
}

export type OperationWorkerResponseMessage =
  OperationWorkerSuccessMessage | OperationWorkerFailureMessage;

export function isOperationWorkerExecuteMessage(
  value: unknown,
): value is OperationWorkerExecuteMessage {
  try {
    if (
      !isRecord(value) ||
      !hasOnlyEnumerableDataProperties(value, EXECUTE_MESSAGE_KEYS, [
        "version",
        "type",
        "taskId",
        "request",
      ])
    ) {
      return false;
    }

    return (
      readDataProperty(value, "version") ===
        OPERATION_WORKER_PROTOCOL_VERSION &&
      readDataProperty(value, "type") === "execute" &&
      isOperationWorkerTaskId(readDataProperty(value, "taskId")) &&
      isRecord(readDataProperty(value, "request"))
    );
  } catch {
    return false;
  }
}

export function isOperationWorkerResponseMessage(
  value: unknown,
): value is OperationWorkerResponseMessage {
  try {
    return isOperationWorkerResponseMessageUnsafe(value);
  } catch {
    return false;
  }
}

function isOperationWorkerResponseMessageUnsafe(
  value: unknown,
): value is OperationWorkerResponseMessage {
  if (!isRecord(value)) return false;
  const type = readDataProperty(value, "type");
  const allowedKeys =
    type === "success"
      ? SUCCESS_MESSAGE_KEYS
      : type === "failure"
        ? FAILURE_MESSAGE_KEYS
        : undefined;
  const payloadKey = type === "success" ? "output" : "error";

  if (
    allowedKeys === undefined ||
    !hasOnlyEnumerableDataProperties(value, allowedKeys, [
      "version",
      "type",
      "taskId",
      payloadKey,
    ]) ||
    readDataProperty(value, "version") !== OPERATION_WORKER_PROTOCOL_VERSION ||
    !isOperationWorkerTaskId(readDataProperty(value, "taskId"))
  ) {
    return false;
  }

  if (type === "success") {
    return readDataProperty(value, "output") !== undefined;
  }

  const error = readDataProperty(value, "error");
  if (
    !isRecord(error) ||
    !hasOnlyEnumerableDataProperties(error, ERROR_KEYS, [
      "name",
      "code",
      "message",
    ])
  ) {
    return false;
  }

  const message = readDataProperty(error, "message");
  const operationId = readDataProperty(error, "operationId");
  const details = readDataProperty(error, "details");
  if (
    readDataProperty(error, "name") !== "OperationError" ||
    !operationErrorCodes.includes(readDataProperty(error, "code") as never) ||
    typeof message !== "string" ||
    message.length === 0 ||
    message.length > MAX_OPERATION_WORKER_ERROR_MESSAGE_LENGTH ||
    (operationId !== undefined &&
      (typeof operationId !== "string" ||
        operationId.length === 0 ||
        operationId.length > MAX_OPERATION_WORKER_TASK_ID_LENGTH))
  ) {
    return false;
  }

  if (details !== undefined) {
    const validation = validateOperationOptions(details);
    if (!validation.ok) return false;
    const serialized = JSON.stringify(validation.value);
    if (
      new TextEncoder().encode(serialized).byteLength >
      MAX_OPERATION_WORKER_ERROR_DETAILS_BYTES
    ) {
      return false;
    }
  }

  return true;
}

/** Collects unique, transferable ArrayBuffers without retaining wrapper views. */
export function collectTransferableBuffers(value: unknown): ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>();
  const visited = new Set<object>();

  function visit(candidate: unknown): void {
    if (candidate instanceof ArrayBuffer) {
      buffers.add(candidate);
      return;
    }

    if (ArrayBuffer.isView(candidate)) {
      if (candidate.buffer instanceof ArrayBuffer) {
        buffers.add(candidate.buffer);
      }
      return;
    }

    if (candidate === null || typeof candidate !== "object") return;
    if (visited.has(candidate)) return;
    visited.add(candidate);

    for (const key of Reflect.ownKeys(candidate)) {
      const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
      if (descriptor !== undefined && "value" in descriptor) {
        visit(descriptor.value);
      }
    }
  }

  visit(value);
  return [...buffers];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function isOperationWorkerTaskId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_OPERATION_WORKER_TASK_ID_LENGTH &&
    TASK_ID_PATTERN.test(value)
  );
}

function readDataProperty(
  value: Record<string, unknown>,
  key: string,
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && "value" in descriptor
    ? descriptor.value
    : undefined;
}

function hasOnlyEnumerableDataProperties(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  required: readonly string[],
): boolean {
  const keys = Reflect.ownKeys(value);
  if (
    keys.some((key) => {
      if (typeof key !== "string" || !allowed.has(key)) return true;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return !(
        descriptor?.enumerable &&
        Object.prototype.hasOwnProperty.call(descriptor, "value")
      );
    })
  ) {
    return false;
  }

  return required.every((key) =>
    Object.prototype.hasOwnProperty.call(value, key),
  );
}

import type { JsonObject } from "./contract";

export const operationErrorCodes = [
  "unknown-operation",
  "type-mismatch",
  "input-too-large",
  "output-too-large",
  "memory-budget",
  "invalid-options",
  "timeout",
  "cancelled",
  "worker-crashed",
  "execution-failed",
  "unsupported-environment",
] as const;

export type OperationErrorCode = (typeof operationErrorCodes)[number];

export interface OperationErrorMetadata {
  readonly operationId?: string;
  readonly details?: Readonly<JsonObject>;
  readonly cause?: unknown;
}

/** Serializable representation used in results and Worker messages. */
export interface SerializedOperationError {
  readonly name: "OperationError";
  readonly code: OperationErrorCode;
  readonly message: string;
  readonly operationId?: string;
  readonly details?: Readonly<JsonObject>;
}

/** The one canonical failure type exposed by the Operation layer. */
export class OperationError extends Error {
  readonly code: OperationErrorCode;
  readonly operationId?: string;
  readonly details?: Readonly<JsonObject>;

  constructor(
    code: OperationErrorCode,
    message: string,
    metadata: OperationErrorMetadata = {},
  ) {
    super(
      message,
      metadata.cause === undefined ? undefined : { cause: metadata.cause },
    );
    this.name = "OperationError";
    this.code = code;
    this.operationId = metadata.operationId;
    this.details = metadata.details;
  }

  toJSON(): SerializedOperationError {
    return {
      name: "OperationError",
      code: this.code,
      message: this.message,
      ...(this.operationId === undefined
        ? {}
        : { operationId: this.operationId }),
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }
}

export function isOperationError(value: unknown): value is OperationError {
  return value instanceof OperationError;
}

export function serializeOperationError(
  error: OperationError,
): SerializedOperationError {
  return error.toJSON();
}

export function deserializeOperationError(
  error: SerializedOperationError,
): OperationError {
  return new OperationError(error.code, error.message, {
    operationId: error.operationId,
    details: error.details,
  });
}

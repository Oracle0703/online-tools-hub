import type { JsonObject } from "../operations/contract";

export const workflowErrorCodes = [
  "invalid-recipe",
  "recipe-too-large",
  "unsupported-format",
  "unsupported-version",
  "too-many-steps",
  "unsafe-value",
  "unknown-operation",
  "invalid-options",
  "incompatible-step",
  "cancelled",
  "operation-failed",
  "run-conflict",
  "vault-limit",
] as const;

export type WorkflowErrorCode = (typeof workflowErrorCodes)[number];

const WORKFLOW_ERROR_MESSAGES: Readonly<Record<WorkflowErrorCode, string>> =
  Object.freeze({
    "invalid-recipe": "The workflow recipe is invalid.",
    "recipe-too-large": "The workflow recipe exceeds the size limit.",
    "unsupported-format": "The workflow recipe format is not supported.",
    "unsupported-version": "The workflow recipe version is not supported.",
    "too-many-steps": "The workflow recipe has too many steps.",
    "unsafe-value": "The workflow recipe contains an unsafe value.",
    "unknown-operation": "The workflow recipe references an unknown operation.",
    "invalid-options": "The workflow step options are invalid.",
    "incompatible-step": "The workflow steps use incompatible payload types.",
    cancelled: "The workflow execution was cancelled.",
    "operation-failed": "The workflow operation failed.",
    "run-conflict": "A workflow execution is already active.",
    "vault-limit": "The workflow payload vault limit was reached.",
  });

export interface WorkflowErrorMetadata {
  readonly stepIndex?: number;
  readonly operationId?: string;
  readonly details?: Readonly<JsonObject>;
  /** Accepted for ergonomic wrapping, but deliberately never retained. */
  readonly cause?: unknown;
}

export interface SerializedWorkflowError {
  readonly name: "WorkflowError";
  readonly code: WorkflowErrorCode;
  readonly message: string;
  readonly stepIndex?: number;
  readonly operationId?: string;
}

/**
 * Public workflow failures deliberately expose no input fragments, callback
 * errors, stack-derived details or payload data.
 */
export class WorkflowError extends Error {
  readonly code: WorkflowErrorCode;
  readonly stepIndex?: number;
  readonly operationId?: string;
  readonly details?: Readonly<JsonObject>;

  constructor(
    code: WorkflowErrorCode,
    messageOrMetadata?: string | WorkflowErrorMetadata,
    metadata: WorkflowErrorMetadata = {},
  ) {
    super(WORKFLOW_ERROR_MESSAGES[code]);
    this.name = "WorkflowError";
    this.code = code;
    const resolved =
      typeof messageOrMetadata === "string"
        ? metadata
        : (messageOrMetadata ?? metadata);
    this.stepIndex = resolved.stepIndex;
    this.operationId = resolved.operationId;
    this.details = resolved.details;
  }

  toJSON(): SerializedWorkflowError {
    return {
      name: "WorkflowError",
      code: this.code,
      message: this.message,
      ...(this.stepIndex === undefined ? {} : { stepIndex: this.stepIndex }),
      ...(this.operationId === undefined
        ? {}
        : { operationId: this.operationId }),
    };
  }
}

export function isWorkflowError(value: unknown): value is WorkflowError {
  return value instanceof WorkflowError;
}

export function serializeWorkflowError(
  error: WorkflowError,
): SerializedWorkflowError {
  return error.toJSON();
}

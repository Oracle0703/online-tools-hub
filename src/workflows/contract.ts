import type { JsonObject } from "../operations/contract";

/** Stable wire identifier. Changing it requires a new migration path. */
export const WORKFLOW_RECIPE_FORMAT = "online-tools-hub/workflow" as const;
export const WORKFLOW_RECIPE_VERSION = 1 as const;

export const MAX_WORKFLOW_RECIPE_BYTES = 64 * 1024;
export const MAX_WORKFLOW_RECIPE_STEPS = 16;
export const MAX_WORKFLOW_RECIPE_DEPTH = 32;
export const MAX_WORKFLOW_RECIPE_NODES = 10_000;

/**
 * A recipe step intentionally contains no payload, result, status or opaque
 * vault identifier. Options are normalized so operation defaults are explicit.
 */
export interface WorkflowStepV1 {
  readonly operationId: string;
  readonly options: Readonly<JsonObject>;
}

/** The only persisted/exported workflow shape supported by v1. */
export interface WorkflowRecipeV1 {
  readonly format: typeof WORKFLOW_RECIPE_FORMAT;
  readonly version: typeof WORKFLOW_RECIPE_VERSION;
  readonly steps: readonly WorkflowStepV1[];
}

/**
 * Operation-aware policy is injected by the planner. The recipe codec remains
 * independent from executable adapters and validates the callback output again.
 */
export interface WorkflowRecipeNormalizationDependencies {
  readonly validateOperationId?: (
    operationId: string,
  ) => boolean | undefined | void;
  readonly normalizeOptions?: (
    operationId: string,
    options: Readonly<JsonObject>,
  ) => unknown;
}

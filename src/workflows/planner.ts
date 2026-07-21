import type {
  JsonObject,
  OperationDeterminism,
  OperationManifest,
  OperationSemanticSignature,
  OperationSemanticType,
} from "../operations/contract";
import { getOperationManifest } from "../operations/catalog";
import {
  normalizeOperationOptions,
  resolveOperationSignature,
} from "../operations/validation";
import type { WorkflowRecipeV1 } from "./contract";
import { WorkflowError } from "./errors";
import { normalizeWorkflowRecipe } from "./recipe-codec";

export interface WorkflowPlanStep {
  readonly stepId: string;
  readonly index: number;
  readonly operationId: string;
  readonly options: Readonly<JsonObject>;
  readonly input: readonly OperationSemanticType[];
  readonly output: OperationSemanticType;
  readonly determinism: OperationDeterminism;
  readonly workingMemoryBytes: number;
}

export interface WorkflowPlan {
  readonly recipe: WorkflowRecipeV1;
  readonly steps: readonly WorkflowPlanStep[];
  readonly deterministic: boolean;
  readonly maxWorkingMemoryBytes: number;
}

export interface WorkflowInitialPayloadMetadata {
  readonly kind: string;
  readonly semanticType: string;
  readonly bytes: number;
}

export interface WorkflowPlannerDependencies {
  readonly getManifest: (operationId: string) => OperationManifest | undefined;
  readonly normalizeOptions: (
    manifest: OperationManifest,
    options: Readonly<JsonObject>,
  ) => Readonly<JsonObject>;
  readonly resolveSignature: (
    manifest: OperationManifest,
    options: Readonly<JsonObject>,
  ) => OperationSemanticSignature;
}

export const defaultWorkflowPlannerDependencies: WorkflowPlannerDependencies =
  Object.freeze({
    getManifest: getOperationManifest,
    normalizeOptions: normalizeOperationOptions,
    resolveSignature: resolveOperationSignature,
  });

function freezeSemanticType(
  value: OperationSemanticType,
): OperationSemanticType {
  return Object.freeze({ kind: value.kind, contentType: value.contentType });
}

function compatible(
  output: OperationSemanticType,
  accepted: readonly OperationSemanticType[],
): boolean {
  const [outputType, outputSubtype] = output.contentType.split("/", 2);
  return accepted.some((candidate) => {
    if (candidate.kind !== output.kind) return false;
    const [acceptedType, acceptedSubtype] = candidate.contentType.split("/", 2);
    return (
      (acceptedType === "*" || acceptedType === outputType) &&
      (acceptedSubtype === "*" || acceptedSubtype === outputSubtype)
    );
  });
}

function normalizedRecipe(
  source: WorkflowRecipeV1,
  steps: readonly WorkflowPlanStep[],
): WorkflowRecipeV1 {
  return Object.freeze({
    format: source.format,
    version: source.version,
    steps: Object.freeze(
      steps.map((step) =>
        Object.freeze({
          operationId: step.operationId,
          options: step.options,
        }),
      ),
    ),
  });
}

/**
 * Compiles a data-only recipe without importing an Operation adapter. All
 * Operation-specific option and signature checks are supplied by the pure
 * manifest catalog through `dependencies`.
 */
export function compileWorkflowRecipe(
  recipe: WorkflowRecipeV1,
  dependencies: WorkflowPlannerDependencies = defaultWorkflowPlannerDependencies,
): WorkflowPlan {
  const steps: WorkflowPlanStep[] = [];

  for (const [index, candidate] of recipe.steps.entries()) {
    const manifest = dependencies.getManifest(candidate.operationId);
    if (manifest === undefined) {
      throw new WorkflowError(
        "unknown-operation",
        "Workflow recipe references an unknown Operation.",
        { stepIndex: index, operationId: candidate.operationId },
      );
    }

    let options: Readonly<JsonObject>;
    let signature: OperationSemanticSignature;
    try {
      options = dependencies.normalizeOptions(manifest, candidate.options);
      signature = dependencies.resolveSignature(manifest, options);
    } catch (error) {
      throw new WorkflowError(
        "invalid-options",
        "Workflow step options are invalid.",
        { stepIndex: index, operationId: manifest.id, cause: error },
      );
    }

    const input = Object.freeze(signature.input.map(freezeSemanticType));
    const output = freezeSemanticType(signature.output);
    const previous = steps.at(-1);
    if (previous !== undefined && !compatible(previous.output, input)) {
      throw new WorkflowError(
        "incompatible-step",
        "Workflow steps have incompatible payload types.",
        {
          stepIndex: index,
          operationId: manifest.id,
          details: {
            previousContentType: previous.output.contentType,
            nextContentTypes: input.map((value) => value.contentType).join(","),
          },
        },
      );
    }

    steps.push(
      Object.freeze({
        stepId: `workflow-step-${index + 1}`,
        index,
        operationId: manifest.id,
        options: Object.freeze({ ...options }),
        input,
        output,
        determinism: signature.determinism,
        workingMemoryBytes: manifest.workingMemoryBytes,
      }),
    );
  }

  if (steps.length === 0) {
    throw new WorkflowError(
      "invalid-recipe",
      "Workflow recipe must contain at least one step.",
    );
  }

  const frozenSteps = Object.freeze(steps);
  return Object.freeze({
    recipe: normalizedRecipe(recipe, frozenSteps),
    steps: frozenSteps,
    deterministic: frozenSteps.every(
      (step) => step.determinism === "deterministic",
    ),
    maxWorkingMemoryBytes: Math.max(
      ...frozenSteps.map((step) => step.workingMemoryBytes),
    ),
  });
}

/** Safe public entrypoint for imported or programmatically created recipes. */
export function compileWorkflowCandidate(
  value: unknown,
  dependencies: WorkflowPlannerDependencies = defaultWorkflowPlannerDependencies,
): WorkflowPlan {
  const recipe = normalizeWorkflowRecipe(value, {
    validateOperationId(operationId) {
      return dependencies.getManifest(operationId) !== undefined;
    },
    normalizeOptions(operationId, options) {
      const manifest = dependencies.getManifest(operationId);
      if (manifest === undefined) {
        throw new WorkflowError("unknown-operation");
      }
      return dependencies.normalizeOptions(manifest, options);
    },
  });
  return compileWorkflowRecipe(recipe, dependencies);
}

export function assertWorkflowInitialPayload(
  plan: WorkflowPlan,
  payload: WorkflowInitialPayloadMetadata,
): void {
  const first = plan.steps[0];
  if (first === undefined) {
    throw new WorkflowError("invalid-recipe", "Workflow plan is empty.");
  }

  const semantic: OperationSemanticType = {
    kind: payload.kind as OperationSemanticType["kind"],
    contentType: payload.semanticType,
  };
  if (!compatible(semantic, first.input)) {
    throw new WorkflowError(
      "incompatible-step",
      "Initial payload is incompatible with the first Workflow step.",
      {
        stepIndex: 0,
        operationId: first.operationId,
        details: {
          actualKind: payload.kind,
          actualContentType: payload.semanticType,
        },
      },
    );
  }
}

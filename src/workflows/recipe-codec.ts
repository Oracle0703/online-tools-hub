import type { JsonObject, JsonValue } from "../operations/contract";
import {
  MAX_WORKFLOW_RECIPE_BYTES,
  MAX_WORKFLOW_RECIPE_DEPTH,
  MAX_WORKFLOW_RECIPE_NODES,
  MAX_WORKFLOW_RECIPE_STEPS,
  WORKFLOW_RECIPE_FORMAT,
  WORKFLOW_RECIPE_VERSION,
  type WorkflowRecipeNormalizationDependencies,
  type WorkflowRecipeV1,
  type WorkflowStepV1,
} from "./contract";
import { WorkflowError, type WorkflowErrorCode } from "./errors";

export type { WorkflowRecipeV1, WorkflowStepV1 } from "./contract";

const RECIPE_KEYS = new Set(["format", "version", "steps"]);
const STEP_KEYS = new Set(["operationId", "options"]);
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const OPERATION_ID_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const MAX_OPERATION_ID_LENGTH = 128;
const URI_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*\s*:/i;
const SCRIPT_SCHEME_PATTERN = /^(?:javascript|vbscript):/i;

interface InspectionState {
  nodes: number;
}

function fail(code: WorkflowErrorCode): never {
  throw new WorkflowError(code);
}

function utf8ByteLength(value: string): number {
  if (value.length > MAX_WORKFLOW_RECIPE_BYTES) {
    return MAX_WORKFLOW_RECIPE_BYTES + 1;
  }
  return new TextEncoder().encode(value).byteLength;
}

function isForbiddenString(value: string): boolean {
  let offset = 0;
  while (offset < value.length && value.charCodeAt(offset) <= 0x20) offset += 1;
  const candidate = value.slice(offset);
  let compactPrefix = "";
  for (const character of candidate.slice(0, 64)) {
    if (character.charCodeAt(0) <= 0x20 || /\s/u.test(character)) continue;
    compactPrefix += character;
  }
  return (
    URI_SCHEME_PATTERN.test(candidate) ||
    URI_SCHEME_PATTERN.test(compactPrefix) ||
    SCRIPT_SCHEME_PATTERN.test(compactPrefix) ||
    candidate.startsWith("//")
  );
}

function inspectNode(state: InspectionState, depth: number): void {
  state.nodes += 1;
  if (state.nodes > MAX_WORKFLOW_RECIPE_NODES) fail("invalid-recipe");
  if (depth > MAX_WORKFLOW_RECIPE_DEPTH) fail("invalid-recipe");
}

function ownDataRecord(
  value: unknown,
  allowedKeys: ReadonlySet<string>,
  requiredKeys: readonly string[],
  errorCode: WorkflowErrorCode,
): Readonly<Record<string, unknown>> {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return fail(errorCode);
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return fail("unsafe-value");
    }

    const result = Object.create(null) as Record<string, unknown>;
    const keys = Reflect.ownKeys(value);
    for (const key of keys) {
      if (
        typeof key !== "string" ||
        FORBIDDEN_KEYS.has(key) ||
        !allowedKeys.has(key)
      ) {
        return fail(
          typeof key === "string" && !FORBIDDEN_KEYS.has(key)
            ? errorCode
            : "unsafe-value",
        );
      }

      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !Object.prototype.hasOwnProperty.call(descriptor, "value")
      ) {
        return fail("unsafe-value");
      }
      result[key] = descriptor.value;
    }

    for (const key of requiredKeys) {
      if (!Object.prototype.hasOwnProperty.call(result, key)) {
        return fail(errorCode);
      }
    }
    return result;
  } catch (error) {
    if (error instanceof WorkflowError) throw error;
    return fail("unsafe-value");
  }
}

function ownDenseArray(
  value: unknown,
  state: InspectionState,
  depth: number,
): readonly unknown[] {
  try {
    if (
      !Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Array.prototype
    ) {
      return fail("invalid-recipe");
    }

    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    const length = lengthDescriptor?.value;
    if (!Number.isSafeInteger(length) || length < 0) {
      return fail("unsafe-value");
    }
    if (length > MAX_WORKFLOW_RECIPE_STEPS) fail("too-many-steps");

    const keys = Reflect.ownKeys(value);
    const keySet = new Set(keys);
    if (keys.length !== length + 1 || !keySet.has("length")) {
      return fail("unsafe-value");
    }

    const result: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const key = String(index);
      if (!keySet.has(key)) return fail("unsafe-value");
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !Object.prototype.hasOwnProperty.call(descriptor, "value")
      ) {
        return fail("unsafe-value");
      }
      inspectNode(state, depth);
      result.push(descriptor.value);
    }
    return result;
  } catch (error) {
    if (error instanceof WorkflowError) throw error;
    return fail("unsafe-value");
  }
}

function cloneJsonValue(
  value: unknown,
  state: InspectionState,
  depth: number,
  active: WeakSet<object>,
): JsonValue {
  inspectNode(state, depth);

  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (
      isForbiddenString(value) ||
      utf8ByteLength(value) > MAX_WORKFLOW_RECIPE_BYTES
    ) {
      return fail("unsafe-value");
    }
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return fail("unsafe-value");
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object") return fail("unsafe-value");
  if (active.has(value)) return fail("unsafe-value");
  active.add(value);

  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        return fail("unsafe-value");
      }
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
      const length = lengthDescriptor?.value;
      if (!Number.isSafeInteger(length) || length < 0) {
        return fail("unsafe-value");
      }
      const keys = Reflect.ownKeys(value);
      const keySet = new Set(keys);
      if (keys.length !== length + 1 || !keySet.has("length")) {
        return fail("unsafe-value");
      }

      const array: JsonValue[] = [];
      for (let index = 0; index < length; index += 1) {
        const key = String(index);
        if (!keySet.has(key)) return fail("unsafe-value");
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (
          descriptor === undefined ||
          !descriptor.enumerable ||
          !Object.prototype.hasOwnProperty.call(descriptor, "value")
        ) {
          return fail("unsafe-value");
        }
        array.push(cloneJsonValue(descriptor.value, state, depth + 1, active));
      }
      return Object.freeze(array);
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return fail("unsafe-value");
    }

    const descriptors: Array<[string, PropertyDescriptor]> = [];
    for (const key of Reflect.ownKeys(value)) {
      if (
        typeof key !== "string" ||
        FORBIDDEN_KEYS.has(key) ||
        isForbiddenString(key)
      ) {
        return fail("unsafe-value");
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !Object.prototype.hasOwnProperty.call(descriptor, "value")
      ) {
        return fail("unsafe-value");
      }
      descriptors.push([key, descriptor]);
    }
    descriptors.sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    );

    const object = Object.create(null) as Record<string, JsonValue>;
    for (const [key, descriptor] of descriptors) {
      object[key] = cloneJsonValue(descriptor.value, state, depth + 1, active);
    }
    return Object.freeze(object);
  } catch (error) {
    if (error instanceof WorkflowError) throw error;
    return fail("unsafe-value");
  } finally {
    active.delete(value);
  }
}

function cloneOptions(
  value: unknown,
  state: InspectionState,
  depth: number,
): Readonly<JsonObject> {
  let cloned: JsonValue;
  try {
    cloned = cloneJsonValue(value, state, depth, new WeakSet());
  } catch (error) {
    if (error instanceof WorkflowError && error.code === "invalid-recipe") {
      return fail("invalid-options");
    }
    throw error;
  }
  if (cloned === null || typeof cloned !== "object" || Array.isArray(cloned)) {
    return fail("invalid-options");
  }
  return cloned as Readonly<JsonObject>;
}

interface StructurallySafeStep {
  readonly operationId: string;
  readonly options: Readonly<JsonObject>;
}

function inspectRecipe(value: unknown): readonly StructurallySafeStep[] {
  const state: InspectionState = { nodes: 0 };
  inspectNode(state, 0);
  const recipe = ownDataRecord(
    value,
    RECIPE_KEYS,
    ["format", "version", "steps"],
    "invalid-recipe",
  );

  if (recipe.format !== WORKFLOW_RECIPE_FORMAT) fail("unsupported-format");
  if (recipe.version !== WORKFLOW_RECIPE_VERSION) fail("unsupported-version");

  inspectNode(state, 1);
  const rawSteps = ownDenseArray(recipe.steps, state, 2);
  const steps: StructurallySafeStep[] = [];
  for (const rawStep of rawSteps) {
    const step = ownDataRecord(
      rawStep,
      STEP_KEYS,
      ["operationId"],
      "invalid-recipe",
    );
    if (
      typeof step.operationId !== "string" ||
      step.operationId.length === 0 ||
      step.operationId.length > MAX_OPERATION_ID_LENGTH ||
      !OPERATION_ID_PATTERN.test(step.operationId)
    ) {
      fail("invalid-recipe");
    }

    const options = cloneOptions(step.options ?? {}, state, 3);
    steps.push({ operationId: step.operationId, options });
  }
  return steps;
}

function canonicalObject(recipe: WorkflowRecipeV1): {
  format: typeof WORKFLOW_RECIPE_FORMAT;
  version: typeof WORKFLOW_RECIPE_VERSION;
  steps: Array<{ operationId: string; options: Readonly<JsonObject> }>;
} {
  return {
    format: WORKFLOW_RECIPE_FORMAT,
    version: WORKFLOW_RECIPE_VERSION,
    steps: recipe.steps.map((step) => ({
      operationId: step.operationId,
      options: step.options,
    })),
  };
}

function assertCanonicalSize(recipe: WorkflowRecipeV1): void {
  const serialized = JSON.stringify(canonicalObject(recipe));
  if (utf8ByteLength(serialized) > MAX_WORKFLOW_RECIPE_BYTES) {
    fail("recipe-too-large");
  }
}

/**
 * Validates an unknown recipe in two phases: every step is made structurally
 * safe before any injected catalog callback is called, then operation-aware
 * defaults are normalized and validated once more.
 */
export function normalizeWorkflowRecipe(
  value: unknown,
  dependencies: WorkflowRecipeNormalizationDependencies = {},
): WorkflowRecipeV1 {
  const inspected = inspectRecipe(value);
  const steps: WorkflowStepV1[] = [];
  const normalizedState: InspectionState = { nodes: 0 };

  for (const step of inspected) {
    if (dependencies.validateOperationId !== undefined) {
      let accepted: boolean | undefined | void;
      try {
        accepted = dependencies.validateOperationId(step.operationId);
      } catch {
        fail("unknown-operation");
      }
      if (accepted !== undefined && accepted !== true) {
        fail("unknown-operation");
      }
    }

    let normalized: unknown = step.options;
    if (dependencies.normalizeOptions !== undefined) {
      try {
        normalized = dependencies.normalizeOptions(
          step.operationId,
          step.options,
        );
      } catch {
        fail("invalid-options");
      }
    }

    let options: Readonly<JsonObject>;
    try {
      options = cloneOptions(normalized, normalizedState, 3);
    } catch {
      fail("invalid-options");
    }
    steps.push(Object.freeze({ operationId: step.operationId, options }));
  }

  const recipe = Object.freeze({
    format: WORKFLOW_RECIPE_FORMAT,
    version: WORKFLOW_RECIPE_VERSION,
    steps: Object.freeze(steps),
  });
  assertCanonicalSize(recipe);
  return recipe;
}

/** v1 is the first format; older, unknown and future versions are rejected. */
export function migrateWorkflowRecipe(
  value: unknown,
  dependencies: WorkflowRecipeNormalizationDependencies = {},
): WorkflowRecipeV1 {
  return normalizeWorkflowRecipe(value, dependencies);
}

/** Parses a bounded UTF-8 JSON document and returns a deeply frozen recipe. */
export function parseWorkflowRecipe(
  source: string,
  dependencies: WorkflowRecipeNormalizationDependencies = {},
): WorkflowRecipeV1 {
  if (typeof source !== "string") fail("invalid-recipe");
  if (utf8ByteLength(source) > MAX_WORKFLOW_RECIPE_BYTES) {
    fail("recipe-too-large");
  }

  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch {
    fail("invalid-recipe");
  }
  return migrateWorkflowRecipe(value, dependencies);
}

/**
 * Revalidates and reconstructs a recipe so fixed envelope/step key ordering is
 * guaranteed and no runtime-only properties can enter the exported document.
 */
export function exportWorkflowRecipeCanonical(
  value: unknown,
  dependencies: WorkflowRecipeNormalizationDependencies = {},
): string {
  const recipe = normalizeWorkflowRecipe(value, dependencies);
  return JSON.stringify(canonicalObject(recipe));
}

/**
 * JSON values accepted by Operation options and safe to cross a Worker
 * boundary. Runtime validation is intentionally stricter than
 * `JSON.stringify`: accessors, sparse arrays and pollution-prone keys are not
 * accepted.
 */
export type JsonPrimitive = string | number | boolean | null;
export type JsonArray = readonly JsonValue[];
export type JsonObject = { readonly [key: string]: JsonValue };
export type JsonValue = JsonPrimitive | JsonArray | JsonObject;

export const operationInputKinds = [
  "empty",
  "text",
  "text-pair",
  "binary",
  "rgba-image",
] as const;

export type OperationInputKind = (typeof operationInputKinds)[number];

export const operationOutputKinds = ["text", "binary"] as const;

export type OperationOutputKind = (typeof operationOutputKinds)[number];

export type EmptyOperationInput = Readonly<{ kind: "empty" }>;

export type TextOperationInput = Readonly<{
  kind: "text";
  text: string;
}>;

export type TextPairOperationInput = Readonly<{
  kind: "text-pair";
  left: string;
  right: string;
}>;

export type BinaryOperationInput = Readonly<{
  kind: "binary";
  data: ArrayBuffer;
}>;

export type RgbaImageOperationInput = Readonly<{
  kind: "rgba-image";
  width: number;
  height: number;
  data: Uint8ClampedArray;
}>;

export type OperationInput =
  | EmptyOperationInput
  | TextOperationInput
  | TextPairOperationInput
  | BinaryOperationInput
  | RgbaImageOperationInput;

export type TextOperationOutput = Readonly<{
  kind: "text";
  text: string;
}>;

export type BinaryOperationOutput = Readonly<{
  kind: "binary";
  data: ArrayBuffer;
  /** A descriptive media type only; it does not affect execution. */
  mimeType?: string;
}>;

export type OperationOutput = TextOperationOutput | BinaryOperationOutput;
export type OperationPayload = OperationInput | OperationOutput;

export const operationExecutionStrategies = [
  "main",
  "adaptive",
  "worker",
] as const;

export type OperationExecutionStrategy =
  (typeof operationExecutionStrategies)[number];

export interface OperationExecutionPolicy {
  readonly strategy: OperationExecutionStrategy;
  /**
   * `main` uses `null`, `worker` uses `0`, and `adaptive` uses the inclusive
   * input-byte threshold at which work moves off the main thread.
   */
  readonly workerThresholdBytes: number | null;
  readonly timeoutMs: number;
}

/**
 * A serializable declaration of environment requirements and privacy
 * boundaries. Network and persistence are deliberately not opt-in: v1.0
 * Operations must forbid both.
 */
export interface OperationCapabilities {
  readonly network: "forbidden";
  readonly persistence: "forbidden";
  readonly environment: readonly string[];
}

/**
 * The complete, versioned and JSON-serializable public Operation contract.
 * Implementations and executable functions must never be placed here.
 */
export interface OperationManifest {
  readonly version: 1;
  readonly id: string;
  readonly toolSlug: string;
  readonly inputKinds: readonly OperationInputKind[];
  readonly outputKinds: readonly OperationOutputKind[];
  readonly maxInputBytes: number;
  readonly maxOutputBytes: number;
  readonly workingMemoryBytes: number;
  readonly execution: OperationExecutionPolicy;
  readonly capabilities: OperationCapabilities;
}

export interface OperationRequest {
  readonly operationId: string;
  readonly input: OperationInput;
  readonly options?: Readonly<JsonObject>;
}

export type OperationExecutionLocation = "main" | "worker";

export interface OperationExecutionContext {
  readonly signal: AbortSignal;
  readonly location: OperationExecutionLocation;
  /** Throws the canonical `cancelled` error when execution was aborted. */
  readonly checkCancelled: () => void;
  /** Throws the canonical `memory-budget` error when `bytes` exceeds budget. */
  readonly assertWorkingMemory: (bytes: number) => void;
}

export type OperationExecute = (
  input: OperationInput,
  options: Readonly<JsonObject>,
  context: OperationExecutionContext,
) => OperationOutput | Promise<OperationOutput>;

/** Runtime registration; unlike `OperationManifest`, this is not serializable. */
export interface OperationDefinition {
  readonly manifest: OperationManifest;
  readonly execute: OperationExecute;
}

// Convenience re-exports keep adapter imports concise while `errors.ts`
// remains the canonical implementation module.
export {
  OperationError,
  deserializeOperationError,
  isOperationError,
  operationErrorCodes,
  serializeOperationError,
} from "./errors";
export type {
  OperationErrorCode,
  OperationErrorMetadata,
  SerializedOperationError,
} from "./errors";

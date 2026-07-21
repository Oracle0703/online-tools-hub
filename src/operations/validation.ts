import {
  operationExecutionStrategies,
  operationInputKinds,
  operationOutputKinds,
  type JsonObject,
  type JsonValue,
  type OperationInput,
  type OperationManifest,
  type OperationOutput,
  type OperationPayload,
  type OperationRequest,
} from "./contract";
import { OperationError } from "./errors";

export type OperationValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: OperationError };

const FORBIDDEN_OBJECT_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);
const OPERATION_ID_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const ENVIRONMENT_CAPABILITY_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_NODES = 10_000;
export const MAX_OPERATION_OPTIONS_BYTES = 64 * 1024;

const MANIFEST_KEYS = new Set([
  "version",
  "id",
  "toolSlug",
  "inputKinds",
  "outputKinds",
  "maxInputBytes",
  "maxOutputBytes",
  "workingMemoryBytes",
  "execution",
  "capabilities",
]);
const EXECUTION_KEYS = new Set([
  "strategy",
  "workerThresholdBytes",
  "timeoutMs",
]);
const CAPABILITY_KEYS = new Set(["network", "persistence", "environment"]);

function success<T>(value: T): OperationValidationResult<T> {
  return { ok: true, value };
}

function failure<T>(error: OperationError): OperationValidationResult<T> {
  return { ok: false, error };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): boolean {
  return Reflect.ownKeys(value).every(
    (key) => typeof key === "string" && allowed.has(key),
  );
}

function hasOnlyEnumerableDataProperties(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): boolean {
  return Reflect.ownKeys(value).every((key) => {
    if (typeof key !== "string" || !allowed.has(key)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return Boolean(
      descriptor?.enumerable &&
      Object.prototype.hasOwnProperty.call(descriptor, "value"),
    );
  });
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function utf8ByteLength(value: string): number {
  let bytes = 0;

  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);

    if (codeUnit < 0x80) {
      bytes += 1;
    } else if (codeUnit < 0x800) {
      bytes += 2;
    } else if (
      codeUnit >= 0xd800 &&
      codeUnit <= 0xdbff &&
      index + 1 < value.length &&
      value.charCodeAt(index + 1) >= 0xdc00 &&
      value.charCodeAt(index + 1) <= 0xdfff
    ) {
      bytes += 4;
      index += 1;
    } else {
      // TextEncoder replaces unpaired surrogates with U+FFFD (three bytes).
      bytes += 3;
    }
  }

  return bytes;
}

function jsonStringByteLength(value: string): number {
  // Opening and closing quotes.
  let bytes = 2;

  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit === 0x22 || codeUnit === 0x5c) {
      bytes += 2;
    } else if (
      codeUnit === 0x08 ||
      codeUnit === 0x09 ||
      codeUnit === 0x0a ||
      codeUnit === 0x0c ||
      codeUnit === 0x0d
    ) {
      bytes += 2;
    } else if (codeUnit < 0x20) {
      bytes += 6;
    } else if (codeUnit < 0x80) {
      bytes += 1;
    } else if (codeUnit < 0x800) {
      bytes += 2;
    } else if (
      codeUnit >= 0xd800 &&
      codeUnit <= 0xdbff &&
      index + 1 < value.length &&
      value.charCodeAt(index + 1) >= 0xdc00 &&
      value.charCodeAt(index + 1) <= 0xdfff
    ) {
      bytes += 4;
      index += 1;
    } else if (codeUnit >= 0xd800 && codeUnit <= 0xdfff) {
      // Well-formed JSON.stringify escapes lone UTF-16 surrogates as \udxxx.
      bytes += 6;
    } else {
      bytes += 3;
    }

    if (bytes > MAX_OPERATION_OPTIONS_BYTES) return bytes;
  }

  return bytes;
}

function jsonValueByteLength(value: JsonValue): number {
  if (value === null) return 4;
  if (typeof value === "string") return jsonStringByteLength(value);
  if (typeof value === "number" || typeof value === "boolean") {
    return utf8ByteLength(String(value));
  }
  if (Array.isArray(value)) {
    let bytes = 2 + Math.max(0, value.length - 1);
    for (const item of value) {
      bytes += jsonValueByteLength(item);
      if (bytes > MAX_OPERATION_OPTIONS_BYTES) return bytes;
    }
    return bytes;
  }

  const entries = Object.entries(value);
  let bytes = 2 + Math.max(0, entries.length - 1);
  for (const [key, item] of entries) {
    bytes += jsonStringByteLength(key) + 1 + jsonValueByteLength(item);
    if (bytes > MAX_OPERATION_OPTIONS_BYTES) return bytes;
  }
  return bytes;
}

/** Counts payload content bytes, excluding small envelope metadata. */
export function payloadByteLength(payload: OperationPayload): number {
  switch (payload.kind) {
    case "empty":
      return 0;
    case "text":
      return utf8ByteLength(payload.text);
    case "text-pair":
      return utf8ByteLength(payload.left) + utf8ByteLength(payload.right);
    case "binary":
      return payload.data.byteLength;
    case "rgba-image":
      return payload.data.byteLength;
  }
}

interface JsonInspectionState {
  active: WeakSet<object>;
  nodes: number;
}

function inspectJsonValue(
  value: unknown,
  depth: number,
  state: JsonInspectionState,
): string | undefined {
  state.nodes += 1;
  if (state.nodes > MAX_JSON_NODES) {
    return `Options exceed the ${MAX_JSON_NODES}-node limit.`;
  }
  if (depth > MAX_JSON_DEPTH) {
    return `Options exceed the maximum nesting depth of ${MAX_JSON_DEPTH}.`;
  }

  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return undefined;
  }

  if (typeof value === "number") {
    return Number.isFinite(value)
      ? undefined
      : "Options may contain only finite JSON numbers.";
  }

  if (typeof value !== "object") {
    return "Options may contain only JSON values.";
  }

  if (state.active.has(value)) {
    return "Options must not contain circular references.";
  }
  state.active.add(value);

  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        return "Options arrays must use the standard Array prototype.";
      }
      if (Object.keys(value).length !== value.length) {
        return "Options arrays must be dense and must not have custom keys.";
      }
      if (
        Reflect.ownKeys(value).some(
          (key) =>
            typeof key === "symbol" || (key !== "length" && !/^\d+$/.test(key)),
        )
      ) {
        return "Options arrays must not contain symbol or custom properties.";
      }

      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(
          value,
          String(index),
        );
        if (
          descriptor === undefined ||
          !descriptor.enumerable ||
          !("value" in descriptor)
        ) {
          return "Options arrays must contain only enumerable data properties.";
        }

        const issue = inspectJsonValue(descriptor.value, depth + 1, state);
        if (issue !== undefined) return issue;
      }
      return undefined;
    }

    if (!isRecord(value)) {
      return "Options objects must use a plain or null prototype.";
    }

    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") {
        return "Options objects must not contain symbol keys.";
      }
      if (FORBIDDEN_OBJECT_KEYS.has(key)) {
        return `Options must not contain the unsafe key '${key}'.`;
      }

      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !("value" in descriptor)
      ) {
        return "Options must contain only enumerable data properties.";
      }

      const issue = inspectJsonValue(descriptor.value, depth + 1, state);
      if (issue !== undefined) return issue;
    }

    return undefined;
  } finally {
    state.active.delete(value);
  }
}

export function validateJsonValue(
  value: unknown,
): OperationValidationResult<JsonValue> {
  const issue = inspectJsonValue(value, 0, {
    active: new WeakSet(),
    nodes: 0,
  });

  return issue === undefined
    ? success(value as JsonValue)
    : failure(new OperationError("invalid-options", issue));
}

export function validateOperationOptions(
  options: unknown,
  operationId?: string,
): OperationValidationResult<Readonly<JsonObject>> {
  if (!isRecord(options)) {
    return failure(
      new OperationError(
        "invalid-options",
        "Operation options must be a JSON object.",
        {
          operationId,
        },
      ),
    );
  }

  const result = validateJsonValue(options);
  if (!result.ok) {
    return failure(
      new OperationError("invalid-options", result.error.message, {
        operationId,
      }),
    );
  }

  const optionsBytes = jsonValueByteLength(result.value);
  if (optionsBytes > MAX_OPERATION_OPTIONS_BYTES) {
    return failure(
      new OperationError(
        "invalid-options",
        `Operation options are ${optionsBytes} bytes; the limit is ${MAX_OPERATION_OPTIONS_BYTES} bytes.`,
        {
          operationId,
          details: {
            actualBytes: optionsBytes,
            maxBytes: MAX_OPERATION_OPTIONS_BYTES,
          },
        },
      ),
    );
  }

  return success(result.value as Readonly<JsonObject>);
}

function validateKinds<T extends string>(
  value: unknown,
  accepted: readonly T[],
): value is readonly T[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((kind): kind is T => accepted.includes(kind as T)) &&
    new Set(value).size === value.length
  );
}

export function validateOperationManifest(
  value: unknown,
): OperationValidationResult<OperationManifest> {
  const invalid = (message: string) =>
    failure<OperationManifest>(
      new OperationError(
        "execution-failed",
        `Invalid Operation manifest: ${message}`,
      ),
    );

  const jsonResult = validateJsonValue(value);
  if (!jsonResult.ok) return invalid(jsonResult.error.message);
  if (!isRecord(value) || !hasOnlyKeys(value, MANIFEST_KEYS)) {
    return invalid("the root must contain only documented manifest fields.");
  }

  if (value.version !== 1) return invalid("version must be 1.");
  if (typeof value.id !== "string" || !OPERATION_ID_PATTERN.test(value.id)) {
    return invalid("id must be a lowercase, delimiter-separated identifier.");
  }
  if (
    typeof value.toolSlug !== "string" ||
    !OPERATION_ID_PATTERN.test(value.toolSlug)
  ) {
    return invalid("toolSlug must be a lowercase slug.");
  }
  if (!validateKinds(value.inputKinds, operationInputKinds)) {
    return invalid(
      "inputKinds must be a non-empty, unique list of supported kinds.",
    );
  }
  if (!validateKinds(value.outputKinds, operationOutputKinds)) {
    return invalid(
      "outputKinds must be a non-empty, unique list of supported kinds.",
    );
  }
  if (!isNonNegativeSafeInteger(value.maxInputBytes)) {
    return invalid("maxInputBytes must be a non-negative safe integer.");
  }
  if (!isPositiveSafeInteger(value.maxOutputBytes)) {
    return invalid("maxOutputBytes must be a positive safe integer.");
  }
  if (!isPositiveSafeInteger(value.workingMemoryBytes)) {
    return invalid("workingMemoryBytes must be a positive safe integer.");
  }
  if (
    value.workingMemoryBytes <
    Math.max(value.maxInputBytes, value.maxOutputBytes)
  ) {
    return invalid(
      "workingMemoryBytes must cover both the maximum input and output payload.",
    );
  }

  if (
    !isRecord(value.execution) ||
    !hasOnlyKeys(value.execution, EXECUTION_KEYS)
  ) {
    return invalid(
      "execution must contain only strategy, workerThresholdBytes and timeoutMs.",
    );
  }
  const { strategy, workerThresholdBytes, timeoutMs } = value.execution;
  if (!operationExecutionStrategies.includes(strategy as never)) {
    return invalid("execution.strategy is unsupported.");
  }
  if (!isPositiveSafeInteger(timeoutMs)) {
    return invalid("execution.timeoutMs must be a positive safe integer.");
  }
  if (strategy === "main" && workerThresholdBytes !== null) {
    return invalid("main execution must use a null worker threshold.");
  }
  if (strategy === "worker" && workerThresholdBytes !== 0) {
    return invalid("worker execution must use a zero-byte worker threshold.");
  }
  if (
    strategy === "adaptive" &&
    (!isPositiveSafeInteger(workerThresholdBytes) ||
      workerThresholdBytes > value.maxInputBytes)
  ) {
    return invalid(
      "adaptive execution needs a positive threshold within maxInputBytes.",
    );
  }

  if (
    !isRecord(value.capabilities) ||
    !hasOnlyKeys(value.capabilities, CAPABILITY_KEYS)
  ) {
    return invalid(
      "capabilities must contain only network, persistence and environment.",
    );
  }
  if (
    value.capabilities.network !== "forbidden" ||
    value.capabilities.persistence !== "forbidden"
  ) {
    return invalid("network and persistence capabilities must be forbidden.");
  }
  const environment = value.capabilities.environment;
  if (
    !Array.isArray(environment) ||
    new Set(environment).size !== environment.length ||
    !environment.every(
      (capability) =>
        typeof capability === "string" &&
        ENVIRONMENT_CAPABILITY_PATTERN.test(capability),
    )
  ) {
    return invalid(
      "capabilities.environment must be a unique list of identifiers.",
    );
  }

  return success(value as unknown as OperationManifest);
}

export function assertOperationManifest(
  value: unknown,
): asserts value is OperationManifest {
  const result = validateOperationManifest(value);
  if (!result.ok) throw result.error;
}

function validateInputShape(
  value: unknown,
  operationId: string,
): OperationValidationResult<OperationInput> {
  const mismatch = (message: string) =>
    failure<OperationInput>(
      new OperationError("type-mismatch", message, { operationId }),
    );

  if (!isRecord(value)) {
    return mismatch(
      "Operation input must be a supported discriminated payload.",
    );
  }

  const kindDescriptor = Object.getOwnPropertyDescriptor(value, "kind");
  const kind =
    kindDescriptor !== undefined && "value" in kindDescriptor
      ? kindDescriptor.value
      : undefined;
  if (typeof kind !== "string") {
    return mismatch(
      "Operation input must use enumerable data properties and a supported kind.",
    );
  }

  switch (kind) {
    case "empty":
      return hasOnlyEnumerableDataProperties(value, new Set(["kind"]))
        ? success(value as EmptyOperationInput)
        : mismatch("Empty input must not contain data fields.");
    case "text":
      return hasOnlyEnumerableDataProperties(
        value,
        new Set(["kind", "text"]),
      ) && typeof value.text === "string"
        ? success(value as unknown as OperationInput)
        : mismatch("Text input must contain only a string text field.");
    case "text-pair":
      return hasOnlyEnumerableDataProperties(
        value,
        new Set(["kind", "left", "right"]),
      ) &&
        typeof value.left === "string" &&
        typeof value.right === "string"
        ? success(value as unknown as OperationInput)
        : mismatch(
            "Text-pair input must contain string left and right fields.",
          );
    case "binary":
      return hasOnlyEnumerableDataProperties(
        value,
        new Set(["kind", "data"]),
      ) && value.data instanceof ArrayBuffer
        ? success(value as unknown as OperationInput)
        : mismatch("Binary input must contain an ArrayBuffer data field.");
    case "rgba-image": {
      if (
        !hasOnlyEnumerableDataProperties(
          value,
          new Set(["kind", "width", "height", "data"]),
        )
      ) {
        return mismatch(
          "RGBA image input must contain only enumerable data properties.",
        );
      }
      const width = value.width;
      const height = value.height;
      const dimensionsAreValid =
        isPositiveSafeInteger(width) &&
        isPositiveSafeInteger(height) &&
        width <= Number.MAX_SAFE_INTEGER / height / 4;
      if (!dimensionsAreValid) {
        return mismatch(
          "RGBA image input needs positive dimensions and exactly width × height × 4 clamped bytes.",
        );
      }
      return value.data instanceof Uint8ClampedArray &&
        value.data.buffer instanceof ArrayBuffer &&
        value.data.byteOffset === 0 &&
        value.data.byteLength === value.data.buffer.byteLength &&
        value.data.byteLength === width * height * 4
        ? success(value as unknown as OperationInput)
        : mismatch(
            "RGBA image input needs positive dimensions and exactly width × height × 4 clamped bytes.",
          );
    }
    default:
      return mismatch("Operation input kind is unsupported.");
  }
}

type EmptyOperationInput = Extract<OperationInput, { kind: "empty" }>;

export function validateOperationRequest(
  manifest: OperationManifest | undefined,
  value: unknown,
): OperationValidationResult<OperationRequest> {
  const operationIdDescriptor = isRecord(value)
    ? Object.getOwnPropertyDescriptor(value, "operationId")
    : undefined;
  const operationId =
    operationIdDescriptor !== undefined &&
    "value" in operationIdDescriptor &&
    typeof operationIdDescriptor.value === "string"
      ? operationIdDescriptor.value
      : undefined;

  if (manifest === undefined || operationId !== manifest.id) {
    return failure(
      new OperationError(
        "unknown-operation",
        "Operation request does not identify a registered operation.",
      ),
    );
  }

  const manifestResult = validateOperationManifest(manifest);
  if (!manifestResult.ok) return failure(manifestResult.error);
  if (
    !isRecord(value) ||
    !hasOnlyEnumerableDataProperties(
      value,
      new Set(["operationId", "input", "options"]),
    )
  ) {
    return failure(
      new OperationError(
        "type-mismatch",
        "Operation request has unsupported fields.",
        {
          operationId,
        },
      ),
    );
  }

  const optionsResult = validateOperationOptions(
    value.options ?? {},
    operationId,
  );
  if (!optionsResult.ok) return failure(optionsResult.error);

  const inputResult = validateInputShape(value.input, operationId);
  if (!inputResult.ok) return failure(inputResult.error);

  if (!manifest.inputKinds.includes(inputResult.value.kind)) {
    return failure(
      new OperationError(
        "type-mismatch",
        `Operation '${operationId}' does not accept '${inputResult.value.kind}' input.`,
        {
          operationId,
          details: {
            actualKind: inputResult.value.kind,
            expectedKinds: manifest.inputKinds,
          },
        },
      ),
    );
  }

  const inputBytes = payloadByteLength(inputResult.value);
  if (inputBytes > manifest.maxInputBytes) {
    return failure(
      new OperationError(
        "input-too-large",
        `Operation input is ${inputBytes} bytes; the limit is ${manifest.maxInputBytes} bytes.`,
        {
          operationId,
          details: {
            actualBytes: inputBytes,
            maxBytes: manifest.maxInputBytes,
          },
        },
      ),
    );
  }

  return success({
    operationId,
    input: inputResult.value,
    options: optionsResult.value,
  });
}

export function assertOperationRequest(
  manifest: OperationManifest | undefined,
  value: unknown,
): asserts value is OperationRequest {
  const result = validateOperationRequest(manifest, value);
  if (!result.ok) throw result.error;
}

function validateOutputShape(
  value: unknown,
  operationId: string,
): OperationValidationResult<OperationOutput> {
  const mismatch = (message: string) =>
    failure<OperationOutput>(
      new OperationError("type-mismatch", message, { operationId }),
    );

  if (!isRecord(value)) {
    return mismatch(
      "Operation output must be a supported discriminated payload.",
    );
  }
  const kindDescriptor = Object.getOwnPropertyDescriptor(value, "kind");
  const kind =
    kindDescriptor !== undefined && "value" in kindDescriptor
      ? kindDescriptor.value
      : undefined;
  if (kind === "text") {
    return hasOnlyEnumerableDataProperties(value, new Set(["kind", "text"])) &&
      typeof value.text === "string"
      ? success(value as unknown as OperationOutput)
      : mismatch("Text output must contain only a string text field.");
  }
  if (kind === "binary") {
    return hasOnlyEnumerableDataProperties(
      value,
      new Set(["kind", "data", "mimeType"]),
    ) &&
      value.data instanceof ArrayBuffer &&
      (value.mimeType === undefined || typeof value.mimeType === "string")
      ? success(value as unknown as OperationOutput)
      : mismatch(
          "Binary output must contain ArrayBuffer data and an optional media type.",
        );
  }
  return mismatch("Operation output kind is unsupported.");
}

export function validateOperationOutput(
  manifest: OperationManifest,
  value: unknown,
): OperationValidationResult<OperationOutput> {
  const outputResult = validateOutputShape(value, manifest.id);
  if (!outputResult.ok) return outputResult;

  if (!manifest.outputKinds.includes(outputResult.value.kind)) {
    return failure(
      new OperationError(
        "type-mismatch",
        `Operation '${manifest.id}' must not produce '${outputResult.value.kind}' output.`,
        {
          operationId: manifest.id,
          details: {
            actualKind: outputResult.value.kind,
            expectedKinds: manifest.outputKinds,
          },
        },
      ),
    );
  }

  const outputBytes = payloadByteLength(outputResult.value);
  if (outputBytes > manifest.maxOutputBytes) {
    return failure(
      new OperationError(
        "output-too-large",
        `Operation output is ${outputBytes} bytes; the limit is ${manifest.maxOutputBytes} bytes.`,
        {
          operationId: manifest.id,
          details: {
            actualBytes: outputBytes,
            maxBytes: manifest.maxOutputBytes,
          },
        },
      ),
    );
  }

  return outputResult;
}

export function validateWorkingMemory(
  manifest: OperationManifest,
  bytes: number,
): OperationValidationResult<number> {
  if (!isNonNegativeSafeInteger(bytes) || bytes > manifest.workingMemoryBytes) {
    return failure(
      new OperationError(
        "memory-budget",
        `Requested working memory is outside the ${manifest.workingMemoryBytes}-byte budget.`,
        {
          operationId: manifest.id,
          details: {
            requestedBytes: Number.isFinite(bytes) ? bytes : "non-finite",
            maxBytes: manifest.workingMemoryBytes,
          },
        },
      ),
    );
  }
  return success(bytes);
}

export function assertWorkingMemoryWithinBudget(
  manifest: OperationManifest,
  bytes: number,
): void {
  const result = validateWorkingMemory(manifest, bytes);
  if (!result.ok) throw result.error;
}

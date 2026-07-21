import type { OperationManifest } from "./contract";

const KIBIBYTE = 1024;
const MEBIBYTE = 1024 * KIBIBYTE;
const ADAPTIVE_WORKER_THRESHOLD = 128 * KIBIBYTE;

const PRIVATE_LOCAL_CAPABILITIES = {
  network: "forbidden",
  persistence: "forbidden",
  environment: [],
} as const;

export const JSON_OPERATION_MANIFEST = {
  version: 1,
  id: "json.transform",
  toolSlug: "json-formatter",
  inputKinds: ["text"],
  outputKinds: ["text"],
  maxInputBytes: 2 * MEBIBYTE,
  maxOutputBytes: 16 * MEBIBYTE,
  workingMemoryBytes: 128 * MEBIBYTE,
  execution: {
    strategy: "adaptive",
    workerThresholdBytes: ADAPTIVE_WORKER_THRESHOLD,
    timeoutMs: 10_000,
  },
  capabilities: PRIVATE_LOCAL_CAPABILITIES,
} as const satisfies OperationManifest;

export const BASE64_OPERATION_MANIFEST = {
  version: 1,
  id: "base64.codec",
  toolSlug: "base64-codec",
  inputKinds: ["text"],
  outputKinds: ["text"],
  maxInputBytes: 2 * MEBIBYTE,
  maxOutputBytes: 6 * MEBIBYTE,
  workingMemoryBytes: 16 * MEBIBYTE,
  execution: {
    strategy: "adaptive",
    workerThresholdBytes: ADAPTIVE_WORKER_THRESHOLD,
    timeoutMs: 10_000,
  },
  capabilities: PRIVATE_LOCAL_CAPABILITIES,
} as const satisfies OperationManifest;

export const URL_OPERATION_MANIFEST = {
  version: 1,
  id: "url.codec",
  toolSlug: "url-codec",
  inputKinds: ["text"],
  outputKinds: ["text"],
  maxInputBytes: 2 * MEBIBYTE,
  maxOutputBytes: 8 * MEBIBYTE,
  workingMemoryBytes: 32 * MEBIBYTE,
  execution: {
    strategy: "adaptive",
    workerThresholdBytes: ADAPTIVE_WORKER_THRESHOLD,
    timeoutMs: 10_000,
  },
  capabilities: PRIVATE_LOCAL_CAPABILITIES,
} as const satisfies OperationManifest;

export const TIMESTAMP_OPERATION_MANIFEST = {
  version: 1,
  id: "timestamp.convert",
  toolSlug: "unix-timestamp",
  inputKinds: ["text"],
  outputKinds: ["text"],
  maxInputBytes: 4 * KIBIBYTE,
  maxOutputBytes: 16 * KIBIBYTE,
  workingMemoryBytes: 1 * MEBIBYTE,
  execution: {
    strategy: "main",
    workerThresholdBytes: null,
    timeoutMs: 2_000,
  },
  capabilities: PRIVATE_LOCAL_CAPABILITIES,
} as const satisfies OperationManifest;

export const UUID_OPERATION_MANIFEST = {
  version: 1,
  id: "uuid.generate",
  toolSlug: "uuid-generator",
  inputKinds: ["empty"],
  outputKinds: ["text"],
  maxInputBytes: 0,
  maxOutputBytes: 64 * KIBIBYTE,
  workingMemoryBytes: 1 * MEBIBYTE,
  execution: {
    strategy: "main",
    workerThresholdBytes: null,
    timeoutMs: 2_000,
  },
  capabilities: {
    ...PRIVATE_LOCAL_CAPABILITIES,
    environment: ["web-crypto"],
  },
} as const satisfies OperationManifest;

export const IMAGE_OPERATION_MANIFEST = {
  version: 1,
  id: "image.rgba-to-png",
  toolSlug: "image-compressor",
  inputKinds: ["rgba-image"],
  outputKinds: ["binary"],
  maxInputBytes: 160_000_000,
  maxOutputBytes: 160 * MEBIBYTE,
  workingMemoryBytes: 512 * MEBIBYTE,
  execution: {
    strategy: "worker",
    workerThresholdBytes: 0,
    timeoutMs: 60_000,
  },
  capabilities: {
    ...PRIVATE_LOCAL_CAPABILITIES,
    environment: ["web-worker"],
  },
} as const satisfies OperationManifest;

export const TEXT_DIFF_OPERATION_MANIFEST = {
  version: 1,
  id: "text.diff",
  toolSlug: "text-diff",
  inputKinds: ["text-pair"],
  outputKinds: ["text"],
  maxInputBytes: 1 * MEBIBYTE,
  maxOutputBytes: 4 * MEBIBYTE,
  workingMemoryBytes: 64 * MEBIBYTE,
  execution: {
    strategy: "worker",
    workerThresholdBytes: 0,
    timeoutMs: 15_000,
  },
  capabilities: PRIVATE_LOCAL_CAPABILITIES,
} as const satisfies OperationManifest;

export const HASH_OPERATION_MANIFEST = {
  version: 1,
  id: "hash.digest",
  toolSlug: "hash-generator",
  inputKinds: ["text", "binary"],
  outputKinds: ["text"],
  maxInputBytes: 20 * MEBIBYTE,
  maxOutputBytes: 128,
  workingMemoryBytes: 64 * MEBIBYTE,
  execution: {
    strategy: "adaptive",
    workerThresholdBytes: ADAPTIVE_WORKER_THRESHOLD,
    timeoutMs: 30_000,
  },
  capabilities: {
    ...PRIVATE_LOCAL_CAPABILITIES,
    environment: ["web-crypto"],
  },
} as const satisfies OperationManifest;

export const YAML_OPERATION_MANIFEST = {
  version: 1,
  id: "yaml.convert",
  toolSlug: "yaml-json-converter",
  inputKinds: ["text"],
  outputKinds: ["text"],
  maxInputBytes: 2 * MEBIBYTE,
  maxOutputBytes: 16 * MEBIBYTE,
  workingMemoryBytes: 128 * MEBIBYTE,
  execution: {
    strategy: "worker",
    workerThresholdBytes: 0,
    timeoutMs: 20_000,
  },
  capabilities: PRIVATE_LOCAL_CAPABILITIES,
} as const satisfies OperationManifest;

export const JWT_OPERATION_MANIFEST = {
  version: 1,
  id: "jwt.decode",
  toolSlug: "jwt-decoder",
  inputKinds: ["text"],
  outputKinds: ["text"],
  maxInputBytes: 256 * KIBIBYTE,
  maxOutputBytes: 1 * MEBIBYTE,
  workingMemoryBytes: 16 * MEBIBYTE,
  execution: {
    strategy: "adaptive",
    workerThresholdBytes: ADAPTIVE_WORKER_THRESHOLD,
    timeoutMs: 10_000,
  },
  capabilities: PRIVATE_LOCAL_CAPABILITIES,
} as const satisfies OperationManifest;

export const CSV_OPERATION_MANIFEST = {
  version: 1,
  id: "csv.convert",
  toolSlug: "csv-json-converter",
  inputKinds: ["text"],
  outputKinds: ["text"],
  maxInputBytes: 2 * MEBIBYTE,
  maxOutputBytes: 16 * MEBIBYTE,
  workingMemoryBytes: 128 * MEBIBYTE,
  execution: {
    strategy: "adaptive",
    workerThresholdBytes: ADAPTIVE_WORKER_THRESHOLD,
    timeoutMs: 20_000,
  },
  capabilities: PRIVATE_LOCAL_CAPABILITIES,
} as const satisfies OperationManifest;

export const QUERY_OPERATION_MANIFEST = {
  version: 1,
  id: "query.inspect",
  toolSlug: "query-params",
  inputKinds: ["text"],
  outputKinds: ["text"],
  maxInputBytes: 2 * MEBIBYTE,
  maxOutputBytes: 16 * MEBIBYTE,
  workingMemoryBytes: 64 * MEBIBYTE,
  execution: {
    strategy: "adaptive",
    workerThresholdBytes: ADAPTIVE_WORKER_THRESHOLD,
    timeoutMs: 15_000,
  },
  capabilities: PRIVATE_LOCAL_CAPABILITIES,
} as const satisfies OperationManifest;

/** Pure data only: importing the catalog must never import adapter algorithms. */
const manifestList: OperationManifest[] = [
  JSON_OPERATION_MANIFEST,
  BASE64_OPERATION_MANIFEST,
  URL_OPERATION_MANIFEST,
  TIMESTAMP_OPERATION_MANIFEST,
  UUID_OPERATION_MANIFEST,
  IMAGE_OPERATION_MANIFEST,
  TEXT_DIFF_OPERATION_MANIFEST,
  HASH_OPERATION_MANIFEST,
  YAML_OPERATION_MANIFEST,
  JWT_OPERATION_MANIFEST,
  CSV_OPERATION_MANIFEST,
  QUERY_OPERATION_MANIFEST,
];

for (const manifest of manifestList) {
  Object.freeze(manifest.inputKinds);
  Object.freeze(manifest.outputKinds);
  Object.freeze(manifest.execution);
  Object.freeze(manifest.capabilities.environment);
  Object.freeze(manifest.capabilities);
  Object.freeze(manifest);
}

export const operationManifests: readonly OperationManifest[] =
  Object.freeze(manifestList);

export const operationIds: readonly string[] = Object.freeze(
  operationManifests.map((manifest) => manifest.id),
);

const manifestById = new Map(
  operationManifests.map((manifest) => [manifest.id, manifest]),
);

export function getOperationManifest(
  operationId: string,
): OperationManifest | undefined {
  return manifestById.get(operationId);
}

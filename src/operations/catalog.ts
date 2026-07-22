import type {
  JsonObject,
  OperationDeterminism,
  OperationInputKind,
  OperationManifest,
  OperationOptionsSchema,
  OperationOutputKind,
  OperationSemanticSignature,
} from "./contract";

const KIBIBYTE = 1024;
const MEBIBYTE = 1024 * KIBIBYTE;
const ADAPTIVE_WORKER_THRESHOLD = 128 * KIBIBYTE;

const PRIVATE_LOCAL_CAPABILITIES = {
  network: "forbidden",
  persistence: "forbidden",
  environment: [],
} as const;

const options = <const T extends OperationOptionsSchema["properties"]>(
  properties: T,
) =>
  ({
    additionalProperties: "forbidden",
    properties,
  }) as const satisfies OperationOptionsSchema;

function signature(
  when: JsonObject,
  input: readonly {
    readonly kind: OperationInputKind;
    readonly contentType: string;
  }[],
  output: {
    readonly kind: OperationOutputKind;
    readonly contentType: string;
  },
  determinism: OperationDeterminism = "deterministic",
): OperationSemanticSignature {
  return { when, input, output, determinism };
}

const JSON_TYPE = "application/json";
const PLAIN_TEXT_TYPE = "text/plain";
const YAML_TYPE = "application/yaml";
const CSV_TYPE = "text/csv";
const JWT_TYPE = "application/jwt";
const QUERY_TYPE = "application/x-www-form-urlencoded";

const COMPOSABLE_TEXT_INPUTS = [
  { kind: "text", contentType: PLAIN_TEXT_TYPE },
  { kind: "text", contentType: JSON_TYPE },
  { kind: "text", contentType: YAML_TYPE },
  { kind: "text", contentType: CSV_TYPE },
  { kind: "text", contentType: JWT_TYPE },
  { kind: "text", contentType: QUERY_TYPE },
] as const;

const BASE64_DECODED_CONTENT_TYPES = [
  PLAIN_TEXT_TYPE,
  JSON_TYPE,
  YAML_TYPE,
  CSV_TYPE,
  JWT_TYPE,
  QUERY_TYPE,
] as const;

const base64Signatures: readonly OperationSemanticSignature[] = [
  signature({ mode: "encode", variant: "standard" }, COMPOSABLE_TEXT_INPUTS, {
    kind: "text",
    contentType: "application/base64",
  }),
  signature({ mode: "encode", variant: "url" }, COMPOSABLE_TEXT_INPUTS, {
    kind: "text",
    contentType: "application/base64url",
  }),
  ...BASE64_DECODED_CONTENT_TYPES.flatMap((contentType) => [
    signature(
      {
        mode: "decode",
        variant: "standard",
        decodedContentType: contentType,
      },
      [{ kind: "text", contentType: "application/base64" }],
      { kind: "text", contentType },
    ),
    signature(
      {
        mode: "decode",
        variant: "url",
        decodedContentType: contentType,
      },
      [{ kind: "text", contentType: "application/base64url" }],
      { kind: "text", contentType },
    ),
  ]),
];

export const JSON_OPERATION_MANIFEST = {
  version: 1,
  id: "json.transform",
  toolSlug: "json-formatter",
  inputKinds: ["text"],
  outputKinds: ["text"],
  maxInputBytes: 2 * MEBIBYTE,
  maxOutputBytes: 16 * MEBIBYTE,
  workingMemoryBytes: 128 * MEBIBYTE,
  options: options({
    mode: {
      type: "enum",
      values: ["format", "minify"],
      default: "format",
    },
    indent: { type: "enum", values: [2, 4, "tab"], default: 2 },
  }),
  signatures: [
    signature({}, [{ kind: "text", contentType: JSON_TYPE }], {
      kind: "text",
      contentType: JSON_TYPE,
    }),
  ],
  determinism: "deterministic",
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
  options: options({
    mode: {
      type: "enum",
      values: ["encode", "decode"],
      default: "encode",
    },
    variant: {
      type: "enum",
      values: ["standard", "url"],
      default: "standard",
    },
    decodedContentType: {
      type: "enum",
      values: BASE64_DECODED_CONTENT_TYPES,
      default: PLAIN_TEXT_TYPE,
    },
  }),
  signatures: base64Signatures,
  determinism: "deterministic",
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
  options: options({
    mode: {
      type: "enum",
      values: ["encode", "decode"],
      default: "encode",
    },
    scope: {
      type: "enum",
      values: ["component", "url"],
      default: "component",
    },
    formEncoding: { type: "boolean", default: false },
  }),
  signatures: [
    signature({ mode: "encode" }, COMPOSABLE_TEXT_INPUTS, {
      kind: "text",
      contentType: QUERY_TYPE,
    }),
    signature({ mode: "decode" }, [{ kind: "text", contentType: QUERY_TYPE }], {
      kind: "text",
      contentType: PLAIN_TEXT_TYPE,
    }),
  ],
  determinism: "deterministic",
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
  options: options({
    direction: {
      type: "enum",
      values: ["timestamp-to-date", "date-to-timestamp"],
      default: "timestamp-to-date",
    },
    unit: {
      type: "enum",
      values: ["auto", "seconds", "milliseconds"],
      default: "auto",
    },
    interpretation: {
      type: "enum",
      values: ["local", "utc"],
      default: "local",
    },
    timeZone: {
      type: "string",
      minimumLength: 1,
      maximumLength: 128,
      nullable: true,
      default: null,
    },
    locale: {
      type: "string",
      minimumLength: 1,
      maximumLength: 64,
      nullable: true,
      default: null,
    },
  }),
  signatures: [
    signature(
      { direction: "timestamp-to-date" },
      [{ kind: "text", contentType: "application/x-unix-timestamp" }],
      { kind: "text", contentType: JSON_TYPE },
      "context-dependent",
    ),
    signature(
      { direction: "date-to-timestamp" },
      [{ kind: "text", contentType: "application/x-iso-datetime" }],
      { kind: "text", contentType: JSON_TYPE },
      "context-dependent",
    ),
  ],
  determinism: "context-dependent",
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
  options: options({
    count: {
      type: "integer",
      minimum: 1,
      maximum: 1_000,
      default: 1,
    },
  }),
  signatures: [
    signature(
      {},
      [{ kind: "empty", contentType: "application/x-empty" }],
      { kind: "text", contentType: "application/x-uuid-list" },
      "random",
    ),
  ],
  determinism: "random",
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
  options: options({
    paletteColors: {
      type: "integer",
      minimum: 2,
      maximum: 256,
      default: 256,
    },
  }),
  signatures: [
    signature({}, [{ kind: "rgba-image", contentType: "image/x-rgba" }], {
      kind: "binary",
      contentType: "image/png",
    }),
  ],
  determinism: "deterministic",
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

export const QR_OPERATION_MANIFEST = {
  version: 1,
  id: "qr.transform",
  toolSlug: "qr-code",
  inputKinds: ["text", "rgba-image"],
  outputKinds: ["text"],
  maxInputBytes: 16_000_000,
  maxOutputBytes: 512 * KIBIBYTE,
  workingMemoryBytes: 96 * MEBIBYTE,
  options: options({
    mode: {
      type: "enum",
      values: ["generate", "scan"],
      default: "generate",
    },
    ecc: {
      type: "enum",
      values: ["L", "M", "Q", "H"],
      default: "M",
    },
    displaySize: {
      type: "enum",
      values: [256, 512, 1024],
      default: 512,
    },
    inversionAttempts: {
      type: "enum",
      values: ["dontInvert", "attemptBoth"],
      default: "attemptBoth",
    },
  }),
  signatures: [
    signature(
      { mode: "generate" },
      [{ kind: "text", contentType: PLAIN_TEXT_TYPE }],
      { kind: "text", contentType: "image/svg+xml" },
    ),
    signature(
      { mode: "scan" },
      [{ kind: "rgba-image", contentType: "image/x-rgba" }],
      { kind: "text", contentType: PLAIN_TEXT_TYPE },
    ),
  ],
  determinism: "deterministic",
  execution: {
    strategy: "worker",
    workerThresholdBytes: 0,
    timeoutMs: 8_000,
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
  options: options({
    ignoreWhitespace: { type: "boolean", default: false },
    ignoreCase: { type: "boolean", default: false },
  }),
  signatures: [
    signature(
      {},
      [{ kind: "text-pair", contentType: "application/x-text-pair" }],
      { kind: "text", contentType: "text/x-diff" },
    ),
  ],
  determinism: "deterministic",
  execution: {
    strategy: "worker",
    workerThresholdBytes: 0,
    timeoutMs: 15_000,
  },
  capabilities: PRIVATE_LOCAL_CAPABILITIES,
} as const satisfies OperationManifest;

export const REGEX_OPERATION_MANIFEST = {
  version: 1,
  id: "regex.test",
  toolSlug: "regex-tester",
  inputKinds: ["text"],
  outputKinds: ["text"],
  // The JSON wire envelope may expand control characters beyond the decoded
  // 8 KiB pattern + 256 KiB subject limits enforced by the core.
  maxInputBytes: 2 * MEBIBYTE,
  maxOutputBytes: 2 * MEBIBYTE,
  workingMemoryBytes: 32 * MEBIBYTE,
  options: options({}),
  signatures: [
    signature({}, [{ kind: "text", contentType: JSON_TYPE }], {
      kind: "text",
      contentType: JSON_TYPE,
    }),
  ],
  determinism: "deterministic",
  execution: {
    strategy: "worker",
    workerThresholdBytes: 0,
    timeoutMs: 2_000,
  },
  capabilities: {
    ...PRIVATE_LOCAL_CAPABILITIES,
    environment: ["web-worker"],
  },
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
  options: options({
    algorithm: {
      type: "enum",
      values: ["SHA-256", "SHA-512"],
      default: "SHA-256",
    },
  }),
  signatures: [
    signature(
      {},
      [
        ...COMPOSABLE_TEXT_INPUTS,
        { kind: "binary", contentType: "application/octet-stream" },
        { kind: "binary", contentType: "image/png" },
      ],
      { kind: "text", contentType: "application/x-hex-digest" },
    ),
  ],
  determinism: "deterministic",
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
  options: options({
    direction: {
      type: "enum",
      values: ["yaml-to-json", "json-to-yaml"],
      default: "yaml-to-json",
    },
    jsonIndent: { type: "enum", values: [2, 4], default: 2 },
  }),
  signatures: [
    signature(
      { direction: "yaml-to-json" },
      [{ kind: "text", contentType: YAML_TYPE }],
      { kind: "text", contentType: JSON_TYPE },
    ),
    signature(
      { direction: "json-to-yaml" },
      [{ kind: "text", contentType: JSON_TYPE }],
      { kind: "text", contentType: YAML_TYPE },
    ),
  ],
  determinism: "deterministic",
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
  options: options({
    nowMilliseconds: {
      type: "integer",
      minimum: -8_640_000_000_000_000,
      maximum: 8_640_000_000_000_000,
    },
  }),
  signatures: [
    signature(
      {},
      [
        { kind: "text", contentType: JWT_TYPE },
        { kind: "text", contentType: PLAIN_TEXT_TYPE },
      ],
      { kind: "text", contentType: JSON_TYPE },
      "context-dependent",
    ),
  ],
  determinism: "context-dependent",
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
  options: options({
    direction: {
      type: "enum",
      values: ["csv-to-json", "json-to-csv"],
      default: "csv-to-json",
    },
    delimiter: {
      type: "enum",
      values: ["auto", ",", ";", "\t"],
      default: "auto",
    },
    jsonIndent: { type: "enum", values: [2, 4], default: 2 },
  }),
  signatures: [
    signature(
      { direction: "csv-to-json" },
      [{ kind: "text", contentType: CSV_TYPE }],
      { kind: "text", contentType: JSON_TYPE },
    ),
    signature(
      { direction: "json-to-csv" },
      [{ kind: "text", contentType: JSON_TYPE }],
      { kind: "text", contentType: CSV_TYPE },
    ),
  ],
  determinism: "deterministic",
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
  options: options({
    encoding: {
      type: "enum",
      values: ["rfc3986", "form"],
      default: "rfc3986",
    },
    sort: { type: "boolean", default: false },
  }),
  signatures: [
    signature(
      {},
      [
        { kind: "text", contentType: PLAIN_TEXT_TYPE },
        { kind: "text", contentType: QUERY_TYPE },
        { kind: "text", contentType: "text/uri-list" },
      ],
      { kind: "text", contentType: JSON_TYPE },
    ),
  ],
  determinism: "deterministic",
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
  QR_OPERATION_MANIFEST,
  TEXT_DIFF_OPERATION_MANIFEST,
  REGEX_OPERATION_MANIFEST,
  HASH_OPERATION_MANIFEST,
  YAML_OPERATION_MANIFEST,
  JWT_OPERATION_MANIFEST,
  CSV_OPERATION_MANIFEST,
  QUERY_OPERATION_MANIFEST,
];

function deepFreezeValue<T>(value: T, seen: WeakSet<object>): T {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return value;
  seen.add(value);

  for (const key of Reflect.ownKeys(value)) {
    deepFreezeValue((value as Record<PropertyKey, unknown>)[key], seen);
  }
  return Object.freeze(value);
}

/** Deep-freezes every serializable manifest branch, including option data. */
export function deepFreezeOperationManifest<T extends OperationManifest>(
  manifest: T,
): T {
  return deepFreezeValue(manifest, new WeakSet());
}

for (const manifest of manifestList) {
  deepFreezeOperationManifest(manifest);
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

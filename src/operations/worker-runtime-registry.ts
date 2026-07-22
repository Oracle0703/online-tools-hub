import { operationIds } from "./catalog";
import type { OperationDefinition } from "./contract";
import { OperationError } from "./errors";

type OperationLoader = () => Promise<OperationDefinition>;

export const QR_OPERATION_ID = "qr.transform";

const workerOperationLoaders = new Map<string, OperationLoader>([
  [
    "json.transform",
    async () => (await import("./adapters/json")).jsonOperationDefinition,
  ],
  [
    "base64.codec",
    async () => (await import("./adapters/base64")).base64OperationDefinition,
  ],
  [
    "url.codec",
    async () => (await import("./adapters/url")).urlOperationDefinition,
  ],
  [
    "timestamp.convert",
    async () =>
      (await import("./adapters/timestamp")).timestampOperationDefinition,
  ],
  [
    "uuid.generate",
    async () => (await import("./adapters/uuid")).uuidOperationDefinition,
  ],
  [
    "image.rgba-to-png",
    async () => (await import("./adapters/image")).imageOperationDefinition,
  ],
  [
    "text.diff",
    async () =>
      (await import("./adapters/text-diff")).textDiffOperationDefinition,
  ],
  [
    "regex.test",
    async () => (await import("./adapters/regex")).regexOperationDefinition,
  ],
  [
    "hash.digest",
    async () => (await import("./adapters/hash")).hashOperationDefinition,
  ],
  [
    "yaml.convert",
    async () => (await import("./adapters/yaml")).yamlOperationDefinition,
  ],
  [
    "jwt.decode",
    async () => (await import("./adapters/jwt")).jwtOperationDefinition,
  ],
  [
    "csv.convert",
    async () => (await import("./adapters/csv")).csvOperationDefinition,
  ],
  [
    "query.inspect",
    async () => (await import("./adapters/query")).queryOperationDefinition,
  ],
]);

export const workerOperationLoaderIds: readonly string[] = Object.freeze([
  ...workerOperationLoaders.keys(),
]);

export async function loadWorkerOperationDefinition(
  operationId: string,
): Promise<OperationDefinition> {
  const loader = workerOperationLoaders.get(operationId);
  if (!loader) {
    throw new OperationError(
      "unknown-operation",
      "Operation is not registered in the shared Worker.",
    );
  }

  const definition = await loader();
  if (definition.manifest.id !== operationId) {
    throw new OperationError(
      "execution-failed",
      `Operation Worker loader mismatch for ${operationId}.`,
      {
        operationId,
        details: { loadedOperationId: definition.manifest.id },
      },
    );
  }
  return definition;
}

const expectedWorkerOperationIds = operationIds.filter(
  (operationId) => operationId !== QR_OPERATION_ID,
);

if (
  expectedWorkerOperationIds.length !== workerOperationLoaderIds.length ||
  expectedWorkerOperationIds.some(
    (operationId) => !workerOperationLoaderIds.includes(operationId),
  )
) {
  throw new OperationError(
    "execution-failed",
    "Operation catalog and shared Worker registry are out of sync.",
  );
}

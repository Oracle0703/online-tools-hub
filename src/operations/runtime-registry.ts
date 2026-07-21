import { operationIds } from "./catalog";
import type { OperationDefinition } from "./contract";
import { OperationError } from "./errors";

type OperationLoader = () => Promise<OperationDefinition>;

const operationLoaders: Readonly<Record<string, OperationLoader>> =
  Object.freeze({
    "json.transform": async () =>
      (await import("./adapters/json")).jsonOperationDefinition,
    "base64.codec": async () =>
      (await import("./adapters/base64")).base64OperationDefinition,
    "url.codec": async () =>
      (await import("./adapters/url")).urlOperationDefinition,
    "timestamp.convert": async () =>
      (await import("./adapters/timestamp")).timestampOperationDefinition,
    "uuid.generate": async () =>
      (await import("./adapters/uuid")).uuidOperationDefinition,
    "image.rgba-to-png": async () =>
      (await import("./adapters/image")).imageOperationDefinition,
    "text.diff": async () =>
      (await import("./adapters/text-diff")).textDiffOperationDefinition,
    "hash.digest": async () =>
      (await import("./adapters/hash")).hashOperationDefinition,
    "yaml.convert": async () =>
      (await import("./adapters/yaml")).yamlOperationDefinition,
    "jwt.decode": async () =>
      (await import("./adapters/jwt")).jwtOperationDefinition,
    "csv.convert": async () =>
      (await import("./adapters/csv")).csvOperationDefinition,
    "query.inspect": async () =>
      (await import("./adapters/query")).queryOperationDefinition,
  } satisfies Record<string, OperationLoader>);

export const operationLoaderIds: readonly string[] = Object.freeze(
  Object.keys(operationLoaders),
);

export async function loadOperationDefinition(
  operationId: string,
): Promise<OperationDefinition> {
  const loader = operationLoaders[operationId];
  if (!loader) {
    throw new OperationError(
      "unknown-operation",
      "Operation is not registered.",
    );
  }

  const definition = await loader();
  if (definition.manifest.id !== operationId) {
    throw new OperationError(
      "execution-failed",
      `Operation loader mismatch for ${operationId}.`,
      {
        operationId,
        details: { loadedOperationId: definition.manifest.id },
      },
    );
  }
  return definition;
}

if (
  operationIds.length !== operationLoaderIds.length ||
  operationIds.some((operationId) => !operationLoaderIds.includes(operationId))
) {
  throw new OperationError(
    "execution-failed",
    "Operation catalog and lazy runtime registry are out of sync.",
  );
}

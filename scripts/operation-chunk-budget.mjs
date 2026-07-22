import { gzipSync } from "node:zlib";
import path from "node:path";

export const maximumOperationClosureGzipBytes = 80 * 1024;

export const operationAdapterBudgetEntries = Object.freeze([
  ["json.transform", "src/operations/adapters/json.ts"],
  ["base64.codec", "src/operations/adapters/base64.ts"],
  ["url.codec", "src/operations/adapters/url.ts"],
  ["timestamp.convert", "src/operations/adapters/timestamp.ts"],
  ["uuid.generate", "src/operations/adapters/uuid.ts"],
  ["image.rgba-to-png", "src/operations/adapters/image.ts"],
  ["qr.transform", "src/operations/adapters/qr.ts"],
  ["text.diff", "src/operations/adapters/text-diff.ts"],
  ["regex.test", "src/operations/adapters/regex.ts"],
  ["hash.digest", "src/operations/adapters/hash.ts"],
  ["yaml.convert", "src/operations/adapters/yaml.ts"],
  ["jwt.decode", "src/operations/adapters/jwt.ts"],
  ["csv.convert", "src/operations/adapters/csv.ts"],
  ["query.inspect", "src/operations/adapters/query.ts"],
]);

function normalizedModuleId(moduleId) {
  return moduleId.split("?", 1)[0].split(path.sep).join("/");
}

function isChunk(output) {
  return output?.type === "chunk" && typeof output.code === "string";
}

function adapterEntryChunk(bundle, sourcePath) {
  const matches = Object.values(bundle).filter(
    (output) =>
      isChunk(output) &&
      typeof output.facadeModuleId === "string" &&
      normalizedModuleId(output.facadeModuleId).endsWith(`/${sourcePath}`),
  );

  if (matches.length !== 1) {
    throw new Error(
      `Operation adapter ${sourcePath} must have exactly one lazy build entry; found ${matches.length}.`,
    );
  }
  return matches[0];
}

function collectStaticClosure(entry, bundle) {
  const files = new Set();
  const queue = [entry.fileName];

  while (queue.length > 0) {
    const fileName = queue.shift();
    if (files.has(fileName)) continue;
    files.add(fileName);

    const chunk = bundle[fileName];
    if (!isChunk(chunk)) {
      throw new Error(
        `Operation closure references missing JavaScript chunk ${fileName}.`,
      );
    }
    for (const importedFile of chunk.imports ?? []) queue.push(importedFile);
  }

  return [...files].sort();
}

export function analyzeOperationChunkBudgets(
  bundle,
  gzipSize = (source) => gzipSync(source).byteLength,
) {
  return operationAdapterBudgetEntries.map(([operationId, sourcePath]) => {
    const entry = adapterEntryChunk(bundle, sourcePath);
    const files = collectStaticClosure(entry, bundle);
    const gzipBytes = files.reduce(
      (total, fileName) => total + gzipSize(bundle[fileName].code),
      0,
    );

    return Object.freeze({
      operationId,
      sourcePath,
      entry: entry.fileName,
      files: Object.freeze(files),
      gzipBytes,
      withinBudget: gzipBytes <= maximumOperationClosureGzipBytes,
    });
  });
}

export function formatOperationChunkBudgetReport(results) {
  const lines = [
    "Lazy Operation JavaScript closures (transitive static imports, gzip)",
    `limit: ${(maximumOperationClosureGzipBytes / 1024).toFixed(1)} KiB per Operation`,
  ];
  for (const result of results) {
    lines.push(
      `${result.withinBudget ? "OK" : "FAIL"} ${result.operationId.padEnd(24)} ${(result.gzipBytes / 1024).toFixed(1).padStart(6)} KiB  ${String(result.files.length).padStart(2)} chunks  ${result.entry}`,
    );
  }
  return lines.join("\n");
}

/**
 * Runs inside the real Astro/Vite client build. Matching adapter source modules
 * to their emitted facade chunks avoids relying on hashed file names or a
 * hand-authored approximation of the production bundle graph.
 */
export function operationChunkBudgetPlugin() {
  return {
    name: "online-tools-hub:operation-chunk-budget",
    applyToEnvironment(environment) {
      return environment.name === "client";
    },
    generateBundle(_options, bundle) {
      const results = analyzeOperationChunkBudgets(bundle);
      this.info(formatOperationChunkBudgetReport(results));

      const failures = results.filter((result) => !result.withinBudget);
      if (failures.length > 0) {
        this.error(
          `Lazy Operation budget exceeded: ${failures
            .map(
              (result) =>
                `${result.operationId} ${(result.gzipBytes / 1024).toFixed(1)} KiB`,
            )
            .join(", ")}.`,
        );
      }
    },
  };
}

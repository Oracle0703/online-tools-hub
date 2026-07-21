import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  forbiddenOperationWorkerGlobals,
  installOperationWorkerPrivacyGuards,
} from "../../src/operations/privacy-guard";

const forbiddenPrimitives = [
  ["fetch", /\bfetch\s*\(/u],
  ["XMLHttpRequest", /\bXMLHttpRequest\b/u],
  ["WebSocket", /\bWebSocket\b/u],
  ["EventSource", /\bEventSource\b/u],
  ["sendBeacon", /\bsendBeacon\s*\(/u],
  ["localStorage", /\blocalStorage\b/u],
  ["sessionStorage", /\bsessionStorage\b/u],
  ["IndexedDB", /\bindexedDB\b/u],
  ["Cache Storage", /\bcaches\s*\.\s*(?:open|match|put|delete|keys)\s*\(/u],
  ["document.cookie", /\bdocument\s*\.\s*cookie\b/u],
  ["history mutation", /\bhistory\s*\.\s*(?:pushState|replaceState)\s*\(/u],
  ["clipboard", /\bclipboard\s*\./u],
  ["eval", /\beval\s*\(/u],
  ["Function constructor", /\bnew\s+Function\s*\(/u],
  ["remote dynamic import", /\bimport\s*\(\s*["'](?:https?:|\/\/)/u],
] as const;

async function operationSourceFiles(): Promise<string[]> {
  const files: string[] = [];

  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
      } else if (
        entry.isFile() &&
        entry.name.endsWith(".ts") &&
        entry.name !== "privacy-guard.ts"
      ) {
        files.push(entryPath);
      }
    }
  }

  await visit(path.resolve("src/operations"));
  await visit(path.resolve("src/tools"));
  files.push(path.resolve("src/workers/operation.worker.ts"));
  files.push(
    path.resolve("node_modules/@upng/upng-js/dist/UPNG.esm.js"),
    path.resolve("node_modules/pako/dist/pako.esm.mjs"),
  );
  return files.sort();
}

describe("operation privacy boundary", () => {
  it("installs fail-closed guards before adapters can reach browser capabilities", () => {
    const target = {};
    installOperationWorkerPrivacyGuards(target);

    expect(forbiddenOperationWorkerGlobals).toEqual(
      expect.arrayContaining([
        "fetch",
        "WebSocket",
        "navigator",
        "indexedDB",
        "caches",
        "Worker",
      ]),
    );
    for (const name of forbiddenOperationWorkerGlobals) {
      expect(() => Reflect.get(target, name)).toThrow(
        expect.objectContaining({
          name: "OperationError",
          code: "execution-failed",
        }),
      );
    }

    expect(() => installOperationWorkerPrivacyGuards(target)).not.toThrow();
    expect(() =>
      installOperationWorkerPrivacyGuards(
        Object.defineProperty({}, "fetch", {
          configurable: false,
          value: () => undefined,
        }),
      ),
    ).toThrow(
      expect.objectContaining({
        name: "OperationError",
        code: "unsupported-environment",
      }),
    );
  });

  it("keeps the serializable catalog isolated from adapter and tool code", async () => {
    const catalog = await readFile(
      path.resolve("src/operations/catalog.ts"),
      "utf8",
    );
    const runtimeRegistry = await readFile(
      path.resolve("src/operations/runtime-registry.ts"),
      "utf8",
    );

    expect(catalog).not.toMatch(
      /(?:from|import\s*\()\s*["'][^"']*(?:adapters|tools)\//u,
    );
    expect(runtimeRegistry).not.toMatch(
      /\bimport\s+[^;(]+\s+from\s+["'][^"']*adapters\//u,
    );
    expect(
      runtimeRegistry.match(/\bimport\s*\(\s*["']\.\/adapters\//gu),
    ).toHaveLength(12);
  });

  it("keeps every operation and its worker free of network and persistence APIs", async () => {
    const violations: string[] = [];

    for (const file of await operationSourceFiles()) {
      const source = await readFile(file, "utf8");
      const relativePath = path.relative(process.cwd(), file);

      for (const [name, pattern] of forbiddenPrimitives) {
        if (pattern.test(source)) violations.push(`${relativePath}: ${name}`);
      }
    }

    expect(violations).toEqual([]);
  });
});

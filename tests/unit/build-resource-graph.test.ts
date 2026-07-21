import { describe, expect, it } from "vitest";

import {
  buildPageResourceGraph,
  classifyPageResourceBudget,
  extractCssResourceReferences,
  extractHtmlResourceReferences,
  extractJavaScriptResourceReferences,
  formatPageResourceBudgetReport,
  resolveLocalAsset,
} from "../../scripts/build-resource-graph.mjs";
import {
  analyzeOperationChunkBudgets,
  formatOperationChunkBudgetReport,
  maximumOperationClosureGzipBytes,
  operationAdapterBudgetEntries,
} from "../../scripts/operation-chunk-budget.mjs";
import { operationIds } from "../../src/operations/catalog";

describe("build resource graph", () => {
  it("finds direct styles, scripts and both Astro Island entry attributes", () => {
    const references = extractHtmlResourceReferences(`
      <link rel="stylesheet" href="/online-tools-hub/assets/page.css?v=1">
      <link rel="manifest" href="/online-tools-hub/manifest.webmanifest">
      <script type="module" src='/online-tools-hub/assets/page.js'></script>
      <astro-island
        component-url="/online-tools-hub/assets/Tool.js"
        renderer-url="/online-tools-hub/assets/client.js"
      ></astro-island>
      <img src="/online-tools-hub/image.png">
    `);

    expect(references).toEqual({
      direct: [
        "/online-tools-hub/assets/page.css?v=1",
        "/online-tools-hub/assets/page.js",
      ],
      islands: [
        {
          attribute: "component-url",
          specifier: "/online-tools-hub/assets/Tool.js",
        },
        {
          attribute: "renderer-url",
          specifier: "/online-tools-hub/assets/client.js",
        },
      ],
    });
  });

  it("finds static, dynamic, CSS and Worker dependencies without mistaking import.meta for an import", () => {
    const references = extractJavaScriptResourceReferences(`
      import "./reset.css";
      import { helper } from "./helper.js";
      export { value } from './value.mjs';
      const lazy = import(\`./lazy.js\`);
      const worker = new Worker(new URL("./compress.worker.js", import.meta.url), { type: "module" });
      const shared = new SharedWorker('./shared.worker.js');
    `);

    expect(references.imports).toEqual([
      { kind: "dynamic-import", specifier: "./lazy.js" },
      { kind: "static-import", specifier: "./reset.css" },
      { kind: "static-import", specifier: "./helper.js" },
      { kind: "static-import", specifier: "./value.mjs" },
    ]);
    expect(references.workers).toEqual([
      "./compress.worker.js",
      "./shared.worker.js",
    ]);
  });

  it("follows quoted CSS imports while ignoring non-CSS assets", () => {
    expect(
      extractCssResourceReferences(`
        @import "./tokens.css";
        @import url('../theme.css?v=2');
        @import url(./print.css) print;
        @import url("https://fonts.example/font.css");
        .logo { background: url("./logo.svg"); }
      `),
    ).toEqual([
      "./tokens.css",
      "../theme.css?v=2",
      "./print.css",
      "https://fonts.example/font.css",
    ]);
  });

  it("resolves base-prefixed, root and importer-relative asset URLs safely", () => {
    expect(
      resolveLocalAsset(
        "/online-tools-hub/assets/page.js?v=1#module",
        "tools/json/index.html",
        "/online-tools-hub/",
      ),
    ).toBe("assets/page.js");
    expect(
      resolveLocalAsset("./chunk.js", "assets/page.js", "/online-tools-hub/"),
    ).toBe("assets/chunk.js");
    expect(
      resolveLocalAsset("/assets/page.css", "index.html", "/online-tools-hub/"),
    ).toBe("assets/page.css");
    expect(
      resolveLocalAsset("https://cdn.example/page.js", "index.html"),
    ).toBeNull();
    expect(
      resolveLocalAsset("../../../outside.js", "assets/page.js"),
    ).toBeNull();
  });

  it.each([
    ["index.html", "home"],
    ["about/index.html", "content"],
    ["guides/local/index.html", "content"],
    ["tools/index.html", "content"],
    ["tools/json-formatter/index.html", "tool"],
    ["studio/index.html", "studio"],
    ["studio/saved/example/index.html", "studio"],
    ["workflows/index.html", "content"],
    ["workflows/base64-json-inspect/index.html", "studio"],
    ["__runtime/operations/index.html", "studio"],
  ])("classifies %s under the %s budget", (route, category) => {
    expect(classifyPageResourceBudget(route)).toBe(category);
  });

  it("walks every import realm recursively and counts each gzip asset only once", async () => {
    const files = new Map<string, string>([
      [
        "assets/main.js",
        'import "./shared.js"; import("./lazy.js"); new Worker(new URL("./worker.js", import.meta.url));',
      ],
      [
        "assets/component.js",
        'import "./shared.js"; import "./component.css";',
      ],
      ["assets/client.js", 'import "./shared.js";'],
      ["assets/shared.js", "export const shared = true;"],
      ["assets/lazy.js", 'import "./shared.js";'],
      ["assets/worker.js", 'import "./shared.js"; import "./worker-dep.js";'],
      ["assets/worker-dep.js", "export const workerOnly = true;"],
      ["styles/page.css", '@import "./tokens.css"; body { color: black; }'],
      ["styles/tokens.css", ":root { --ink: black; }"],
      ["assets/component.css", ".component { display: block; }"],
    ]);
    const graph = await buildPageResourceGraph({
      route: "tools/example/index.html",
      basePath: "/online-tools-hub/",
      html: `
        <link rel="stylesheet" href="/online-tools-hub/styles/page.css">
        <script src="/online-tools-hub/assets/main.js"></script>
        <astro-island
          component-url="/online-tools-hub/assets/component.js"
          renderer-url="/online-tools-hub/assets/client.js"
        ></astro-island>
      `,
      loadAsset: async (assetPath: string) => {
        const file = files.get(assetPath);
        if (file === undefined) throw new Error("not found");
        return file;
      },
      gzipSize: () => 1,
    });

    expect(graph.category).toBe("tool");
    expect(graph.assets.map(({ path }) => path).sort()).toEqual(
      [...files.keys()].sort(),
    );
    expect(graph.totalGzipBytes).toBe(11);
    expect(graph.breakdown).toEqual({
      html: 1,
      css: 3,
      javascript: 5,
      workerJavascript: 2,
      other: 0,
    });
    expect(
      graph.assets.find(({ path }) => path === "assets/shared.js")?.realms,
    ).toEqual(["main", "worker"]);
    expect(
      graph.assets.find(({ path }) => path === "assets/worker.js"),
    ).toMatchObject({ workerEntry: true, realms: ["worker"] });
  });

  it("reports a missing transitive build asset with page context", async () => {
    await expect(
      buildPageResourceGraph({
        route: "index.html",
        html: '<script src="/assets/main.js"></script>',
        loadAsset: async (assetPath: string) => {
          if (assetPath === "assets/main.js") return 'import "./missing.js";';
          throw new Error("ENOENT");
        },
      }),
    ).rejects.toThrow(
      "assets/missing.js, referenced by ./missing.js from index.html",
    );
  });

  it("formats a readable budget row and failing asset diagnosis", async () => {
    const graph = await buildPageResourceGraph({
      route: "index.html",
      html: '<script src="/assets/main.js"></script>',
      loadAsset: async () => "export const ready = true;",
      gzipSize: () => 300 * 1024,
    });
    const report = formatPageResourceBudgetReport([graph]);

    expect(report).toContain("Page resource graph budgets");
    expect(report).toContain("FAIL");
    expect(report).toContain("Category summary (typical = median page)");
    expect(report).toContain(
      "studio   no routes yet; reserved budget 260.0 KiB",
    );
    expect(report).toContain("Largest assets for /");
    expect(report).toContain("assets/main.js");
  });
});

describe("lazy Operation build budgets", () => {
  function fixtureBundle() {
    const bundle: Record<string, Record<string, unknown>> = {
      "assets/shared.js": {
        type: "chunk",
        fileName: "assets/shared.js",
        facadeModuleId: null,
        imports: [],
        code: "shared",
      },
    };

    for (const [operationId, sourcePath] of operationAdapterBudgetEntries) {
      const fileName = `assets/${operationId}.js`;
      bundle[fileName] = {
        type: "chunk",
        fileName,
        facadeModuleId: `/repo/${sourcePath}?build`,
        imports: ["assets/shared.js"],
        code: operationId,
      };
    }
    return bundle;
  }

  it("covers every registered Operation and measures its emitted static closure", () => {
    expect(operationAdapterBudgetEntries.map(([id]) => id)).toEqual(
      operationIds,
    );

    const results = analyzeOperationChunkBudgets(
      fixtureBundle(),
      (source: string) => source.length,
    );
    expect(results).toHaveLength(operationIds.length);
    expect(results[0]).toMatchObject({
      operationId: "json.transform",
      files: ["assets/json.transform.js", "assets/shared.js"],
      gzipBytes: "json.transform".length + "shared".length,
      withinBudget: true,
    });
    expect(formatOperationChunkBudgetReport(results)).toContain(
      "Lazy Operation JavaScript closures",
    );
  });

  it("fails closed when an adapter entry is absent or exceeds 80 KiB", () => {
    const missing = fixtureBundle();
    delete missing["assets/json.transform.js"];
    expect(() => analyzeOperationChunkBudgets(missing)).toThrow(
      "must have exactly one lazy build entry",
    );

    const oversized = fixtureBundle();
    const results = analyzeOperationChunkBudgets(oversized, (source: string) =>
      source === "json.transform"
        ? maximumOperationClosureGzipBytes
        : source.length,
    );
    expect(results[0]?.withinBudget).toBe(false);
  });
});

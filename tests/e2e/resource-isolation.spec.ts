import { readFile } from "node:fs/promises";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { buildPageResourceGraph } from "../../scripts/build-resource-graph.mjs";

const KIBIBYTE = 1024;

type ResourceBudgetCase = {
  name: string;
  route: string;
  buildRoute: string;
  maxAccountedBytes: number;
  allowedToolStyles: readonly string[];
};

type BrowserResource = {
  url: string;
  pathname: string;
  initiatorType: string;
  transferSize: number;
  encodedBodySize: number;
  accountedBytes: number;
};

type BrowserResourceSnapshot = {
  resources: BrowserResource[];
  totalAccountedBytes: number;
};

const resourceBudgetCases: readonly ResourceBudgetCase[] = [
  {
    name: "知识中心内容页",
    route: "./guides/",
    buildRoute: "guides/index.html",
    maxAccountedBytes: 352 * KIBIBYTE,
    allowedToolStyles: [],
  },
  {
    name: "首页",
    route: "./",
    buildRoute: "index.html",
    maxAccountedBytes: 520 * KIBIBYTE,
    allowedToolStyles: [],
  },
  {
    name: "JSON 工具页",
    route: "./tools/json-formatter/",
    buildRoute: "tools/json-formatter/index.html",
    maxAccountedBytes: 400 * KIBIBYTE,
    allowedToolStyles: ["JsonFormatter"],
  },
  {
    name: "YAML 工具页",
    route: "./tools/yaml-json-converter/",
    buildRoute: "tools/yaml-json-converter/index.html",
    maxAccountedBytes: 520 * KIBIBYTE,
    allowedToolStyles: ["YamlJsonConverter"],
  },
] as const;

function toolStyleName(pathname: string): string | undefined {
  const filename = pathname.split("/").at(-1) ?? "";
  return /^([A-Za-z0-9]+?)(?:Tool|Runtime)\.[A-Za-z0-9_-]+\.css$/u.exec(
    filename,
  )?.[1];
}

function displayBytes(bytes: number): string {
  return `${(bytes / KIBIBYTE).toFixed(1)} KiB`;
}

function resourceDiagnostic(snapshot: BrowserResourceSnapshot): string {
  return snapshot.resources
    .toSorted((left, right) => right.accountedBytes - left.accountedBytes)
    .map(
      (resource) =>
        `${displayBytes(resource.accountedBytes).padStart(10)}  ${resource.initiatorType.padEnd(10)}  ${resource.pathname}`,
    )
    .join("\n");
}

function publicBasePath(pageUrl: string, buildRoute: string): string {
  const pathname = new URL(pageUrl).pathname;
  const routeSuffix =
    buildRoute === "index.html" ? "" : buildRoute.replace(/index\.html$/u, "");

  if (!pathname.endsWith(routeSuffix)) {
    throw new Error(
      `页面路径 ${pathname} 与构建路由 ${buildRoute} 不匹配，无法解析公开 base。`,
    );
  }

  const basePath = pathname.slice(0, pathname.length - routeSuffix.length);
  return basePath.endsWith("/") ? basePath : `${basePath}/`;
}

function browserBuildAssetPaths(
  snapshot: BrowserResourceSnapshot,
  basePath: string,
): string[] {
  return [
    ...new Set(
      snapshot.resources
        .map((resource) => {
          let pathname = resource.pathname;
          try {
            pathname = decodeURIComponent(pathname);
          } catch {
            // Keep the encoded pathname so the mismatch remains diagnosable.
          }

          return pathname.startsWith(basePath)
            ? pathname.slice(basePath.length)
            : pathname;
        })
        // WebKit exposes the Service Worker update request through the page's
        // Resource Timing buffer while Chromium and Firefox do not. Keep that
        // request in the byte budget, but compare only Vite's page bundles;
        // Service Worker integrity has its own PWA build and browser gates.
        .filter(
          (assetPath) =>
            assetPath.startsWith("assets/") && /\.(?:css|js)$/u.test(assetPath),
        ),
    ),
  ].sort();
}

async function expectedBuildAssetPaths(
  buildRoute: string,
  basePath: string,
): Promise<string[]> {
  const distPath = path.resolve("dist");
  const html = await readFile(path.join(distPath, buildRoute));
  const graph = await buildPageResourceGraph({
    route: buildRoute,
    html,
    basePath,
    loadAsset: (assetPath: string) => readFile(path.join(distPath, assetPath)),
  });

  return graph.assets
    .map((asset) => asset.path)
    .filter(
      (assetPath) =>
        assetPath.startsWith("assets/") && /\.(?:css|js)$/u.test(assetPath),
    )
    .sort();
}

async function waitForLoadedIslands(page: Page): Promise<void> {
  await page.waitForFunction(() =>
    [...document.querySelectorAll('astro-island[client="load"]')].every(
      (island) => !island.hasAttribute("ssr"),
    ),
  );
  await page.waitForLoadState("networkidle");
}

async function browserResourceSnapshot(
  page: Page,
): Promise<BrowserResourceSnapshot> {
  return page.evaluate(() => {
    type ResourceRecord = {
      url: string;
      pathname: string;
      initiatorType: string;
      transferSize: number;
      encodedBodySize: number;
      accountedBytes: number;
    };

    const entries = [
      ...performance.getEntriesByType("navigation"),
      ...performance.getEntriesByType("resource"),
    ] as Array<PerformanceNavigationTiming | PerformanceResourceTiming>;
    const resourcesByUrl = new Map<string, ResourceRecord>();

    for (const entry of entries) {
      let url: URL;
      try {
        url = new URL(entry.name, window.location.href);
      } catch {
        continue;
      }

      if (url.origin !== window.location.origin) continue;

      const transferSize = Number.isFinite(entry.transferSize)
        ? entry.transferSize
        : 0;
      const encodedBodySize = Number.isFinite(entry.encodedBodySize)
        ? entry.encodedBodySize
        : 0;
      // Local preview servers do not have to compress responses, while Pages
      // and browser caches can report transferSize as zero. Counting the
      // larger available value produces a stable upper-bound in all engines.
      const accountedBytes = Math.max(transferSize, encodedBodySize);
      const candidate: ResourceRecord = {
        url: url.href,
        pathname: url.pathname,
        initiatorType:
          "initiatorType" in entry && entry.initiatorType
            ? entry.initiatorType
            : "navigation",
        transferSize,
        encodedBodySize,
        accountedBytes,
      };
      const previous = resourcesByUrl.get(candidate.url);

      // Treat the timing entries as the set of resources needed by the page.
      // Duplicate link/module requests can be cache hits; retaining the largest
      // observation avoids counting a cached body twice while still charging a
      // cold response in Chromium, Firefox and WebKit.
      if (!previous || candidate.accountedBytes > previous.accountedBytes) {
        resourcesByUrl.set(candidate.url, candidate);
      }
    }

    const resources = [...resourcesByUrl.values()].sort((left, right) =>
      left.url.localeCompare(right.url),
    );

    return {
      resources,
      totalAccountedBytes: resources.reduce(
        (total, resource) => total + resource.accountedBytes,
        0,
      ),
    };
  });
}

test.describe("浏览器真实资源预算与工具 CSS 隔离", () => {
  for (const budgetCase of resourceBudgetCases) {
    test(`${budgetCase.name}只请求允许的样式且保持在传输预算内`, async ({
      page,
    }) => {
      const response = await page.goto(budgetCase.route, {
        waitUntil: "domcontentloaded",
      });

      expect(response?.ok(), `${budgetCase.name}应成功加载`).toBe(true);
      await waitForLoadedIslands(page);
      if (budgetCase.allowedToolStyles.length > 0) {
        await expect(page.locator("[data-tool-workspace]")).toBeVisible();
      }

      const snapshot = await browserResourceSnapshot(page);
      expect(
        snapshot.resources.length,
        `${budgetCase.name}应暴露导航和静态资源的 Performance Timing 记录`,
      ).toBeGreaterThan(1);
      expect(
        snapshot.resources.some((resource) =>
          resource.pathname.endsWith(".css"),
        ),
        `${budgetCase.name}应记录实际加载的共享样式`,
      ).toBe(true);
      expect(snapshot.totalAccountedBytes).toBeGreaterThan(0);
      const basePath = publicBasePath(page.url(), budgetCase.buildRoute);
      const browserAssets = browserBuildAssetPaths(snapshot, basePath);
      const buildAssets = await expectedBuildAssetPaths(
        budgetCase.buildRoute,
        basePath,
      );
      const missing = buildAssets.filter(
        (assetPath) => !browserAssets.includes(assetPath),
      );
      const unexpected = browserAssets.filter(
        (assetPath) => !buildAssets.includes(assetPath),
      );

      expect(
        { missing, unexpected },
        `${budgetCase.name}的构建资源图与浏览器真实请求不一致`,
      ).toEqual({ missing: [], unexpected: [] });
      const toolStyles = [
        ...new Set(
          snapshot.resources
            .map((resource) => toolStyleName(resource.pathname))
            .filter((name): name is string => Boolean(name)),
        ),
      ].sort();
      const allowedToolStyles = [...budgetCase.allowedToolStyles].sort();

      expect(
        toolStyles,
        `${budgetCase.name}的工具专属 CSS 集合不正确；实际：${toolStyles.join("、") || "无"}；预期：${allowedToolStyles.join("、") || "无"}`,
      ).toEqual(allowedToolStyles);
      expect(
        snapshot.totalAccountedBytes,
        `${budgetCase.name}实际资源为 ${displayBytes(snapshot.totalAccountedBytes)}，预算为 ${displayBytes(budgetCase.maxAccountedBytes)}。\n${resourceDiagnostic(snapshot)}`,
      ).toBeLessThanOrEqual(budgetCase.maxAccountedBytes);
    });
  }
});

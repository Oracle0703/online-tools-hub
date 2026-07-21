import { gzipSync } from "node:zlib";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildPageResourceGraph,
  formatBytes,
  formatPageResourceBudgetReport,
} from "./build-resource-graph.mjs";

const dist = new URL("../dist/", import.meta.url);
const distPath = fileURLToPath(dist);
const basePath = "/online-tools-hub/";
const maximumToolScriptGzipBytes = 100 * 1024;

const requiredRoutes = [
  "index.html",
  "404.html",
  "offline.html",
  "service-worker.js",
  "manifest.webmanifest",
  "icons/app-icon-192.png",
  "icons/app-icon-512.png",
  "icons/app-icon-maskable-512.png",
  "THIRD_PARTY_NOTICES.txt",
  "privacy/index.html",
  "tools/index.html",
  "tools/json-formatter/index.html",
  "tools/base64-codec/index.html",
  "tools/url-codec/index.html",
  "tools/unix-timestamp/index.html",
  "tools/uuid-generator/index.html",
  "tools/image-compressor/index.html",
  "tools/text-diff/index.html",
  "tools/hash-generator/index.html",
  "tools/yaml-json-converter/index.html",
  "tools/jwt-decoder/index.html",
  "tools/csv-json-converter/index.html",
  "tools/query-params/index.html",
  "guides/index.html",
  "guides/base64-is-not-encryption/index.html",
  "guides/jwt-decode-vs-verify/index.html",
  "guides/verify-file-sha256/index.html",
  "guides/csv-json-data-safety/index.html",
  "guides/image-compression-quality-size/index.html",
  "guides/yaml-json-differences/index.html",
  "guides/url-query-parameters/index.html",
  "guides/local-browser-tools-privacy/index.html",
];

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collectFiles(absolute)));
    else files.push(absolute);
  }

  return files;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

for (const route of requiredRoutes) {
  const routeUrl = new URL(route, dist);
  assert(
    await stat(routeUrl).then(
      (entry) => entry.isFile(),
      () => false,
    ),
    `缺少静态直达路由：${route}`,
  );
}

const homepage = await readFile(new URL("index.html", dist), "utf8");
assert(
  homepage.includes("从问题出发，而不是从工具名出发"),
  "首页缺少常见任务内容",
);
assert(homepage.includes("最近更新"), "首页缺少最近更新内容");
const homepageDescription =
  homepage.match(/<meta name="description" content="([^"]+)"/u)?.[1] ?? "";
for (const keyword of [
  "智能识别",
  "CSV",
  "URL 参数",
  "图片压缩",
  "SHA 哈希",
  "JWT",
]) {
  assert(homepageDescription.includes(keyword), `首页 SEO 描述缺少 ${keyword}`);
}

const changelog = await readFile(new URL("changelog/index.html", dist), "utf8");
assert(changelog.includes("0.9.0"), "更新日志缺少 0.9.0 记录");

const notices = await readFile(
  new URL("THIRD_PARTY_NOTICES.txt", dist),
  "utf8",
);
assert(notices.includes("yaml"), "部署产物缺少 yaml 第三方许可声明");
assert(notices.includes("Copyright Eemeli Aro"), "yaml 许可版权声明不完整");

const manifest = JSON.parse(
  await readFile(new URL("manifest.webmanifest", dist), "utf8"),
);
assert(manifest.start_url === basePath, "PWA start_url 未限定在仓库子路径");
assert(manifest.scope === basePath, "PWA scope 未限定在仓库子路径");
assert(
  manifest.icons?.some(
    (icon) => icon.sizes === "192x192" && icon.type === "image/png",
  ),
  "PWA 清单缺少 192x192 PNG 图标",
);
assert(
  manifest.icons?.some(
    (icon) =>
      icon.sizes === "512x512" &&
      icon.type === "image/png" &&
      icon.purpose === "maskable",
  ),
  "PWA 清单缺少 512x512 maskable PNG 图标",
);

const serviceWorker = await readFile(
  new URL("service-worker.js", dist),
  "utf8",
);
assert(
  serviceWorker.includes(`const BASE_PATH = ${JSON.stringify(basePath)}`),
  "Service Worker 未限定在仓库子路径",
);
assert(
  !serviceWorker.includes("cache.put("),
  "Service Worker 不得把运行期请求写入缓存",
);
assert(
  !serviceWorker.includes('addEventListener("sync"') &&
    !serviceWorker.includes('addEventListener("push"'),
  "Service Worker 不得启用后台同步或推送",
);
const precacheSource = serviceWorker.match(
  /const PRECACHE_URLS = Object\.freeze\((\[[\s\S]*?\])\);/u,
)?.[1];
assert(precacheSource, "Service Worker 缺少可验证的预缓存清单");
const precacheUrls = new Set(JSON.parse(precacheSource));
for (const route of requiredRoutes.filter(
  (route) => route !== "service-worker.js",
)) {
  const publicUrl =
    route === "index.html"
      ? basePath
      : `${basePath}${route.replace(/index\.html$/u, "")}`;
  assert(precacheUrls.has(publicUrl), `PWA 预缓存缺少 ${publicUrl}`);
}

for (const route of requiredRoutes.filter(
  (route) => route.startsWith("tools/") && route !== "tools/index.html",
)) {
  const html = await readFile(new URL(route, dist), "utf8");
  assert(html.includes("实际场景"), `${route} 缺少实际使用场景`);
  assert(
    html.includes('"softwareVersion":"0.9.0"'),
    `${route} 的结构化数据版本不是 0.9.0`,
  );
}

const allFiles = await collectFiles(distPath);
const htmlFiles = allFiles.filter((file) => file.endsWith(".html"));
const scriptFiles = allFiles.filter((file) => file.endsWith(".js"));
const resourceGraphs = [];

for (const file of htmlFiles) {
  const relative = path.relative(distPath, file);
  const html = await readFile(file, "utf8");
  const cspMatches = [
    ...html.matchAll(
      /<meta http-equiv="content-security-policy" content="([^"]+)">/gu,
    ),
  ];
  const csp = cspMatches[0]?.[1];
  const cspPosition = html.indexOf(cspMatches[0]?.[0] ?? "");
  const protectedResourcePositions = [
    html.search(/<script\b/iu),
    html.search(/<style\b/iu),
    html.search(/<link\b[^>]*\brel="stylesheet"/iu),
  ].filter((position) => position >= 0);

  assert(csp, `${relative} 缺少构建期 meta CSP`);
  assert(cspMatches.length === 1, `${relative} 必须且只能包含一个 meta CSP`);
  assert(
    protectedResourcePositions.every((position) => cspPosition < position),
    `${relative} 的 meta CSP 必须位于首个脚本或样式资源之前`,
  );
  assert(!csp.includes("unsafe-eval"), `${relative} 的 CSP 禁止 unsafe-eval`);
  assert(
    !csp.includes("unsafe-inline"),
    `${relative} 的 CSP 禁止 unsafe-inline`,
  );
  assert(
    /script-src 'self' 'sha256-/u.test(csp),
    `${relative} 的脚本未使用 hash-based CSP`,
  );
  assert(
    /style-src 'self' 'sha256-/u.test(csp),
    `${relative} 的样式未使用 hash-based CSP`,
  );
  for (const requiredDirective of [
    "default-src 'self'",
    "connect-src 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "img-src 'self' data: blob:",
    "worker-src 'self'",
  ]) {
    assert(
      csp.includes(requiredDirective),
      `${relative} 的 CSP 缺少 ${requiredDirective}`,
    );
  }

  resourceGraphs.push(
    await buildPageResourceGraph({
      route: relative.split(path.sep).join("/"),
      html,
      basePath,
      loadAsset: (assetPath) => readFile(path.join(distPath, assetPath)),
    }),
  );
}

console.log(formatPageResourceBudgetReport(resourceGraphs));
const resourceBudgetFailures = resourceGraphs.filter(
  (graph) => !graph.withinBudget,
);
assert(
  resourceBudgetFailures.length === 0,
  `页面资源图预算超限：${resourceBudgetFailures
    .map(
      (graph) =>
        `${graph.routeLabel} ${formatBytes(graph.totalGzipBytes)} > ${formatBytes(graph.budgetBytes)}`,
    )
    .join(", ")}`,
);

for (const file of scriptFiles) {
  const gzipBytes = gzipSync(await readFile(file)).byteLength;
  assert(
    gzipBytes <= maximumToolScriptGzipBytes,
    `${path.relative(distPath, file)} gzip 后 ${gzipBytes} B 超过 ${maximumToolScriptGzipBytes} B`,
  );
}

const sitemap = await readFile(new URL("sitemap.xml", dist), "utf8");
for (const route of requiredRoutes.filter(
  (route) => route.startsWith("tools/") || route.startsWith("guides/"),
)) {
  const routePath = route.replace(/index\.html$/u, "");
  assert(
    sitemap.includes(`${basePath}${routePath}`),
    `sitemap 缺少 ${basePath}${routePath}`,
  );
}

console.log(
  `Verified ${htmlFiles.length} HTML routes, ${scriptFiles.length} scripts and production CSP/budgets.`,
);

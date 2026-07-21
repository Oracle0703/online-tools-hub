import { gzipSync } from "node:zlib";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildPageResourceGraph,
  formatBytes,
  formatPageResourceBudgetReport,
} from "./build-resource-graph.mjs";
import {
  MAX_PWA_ENTRY_BYTES,
  MAX_PWA_PACKAGE_BYTES,
  MAX_PWA_PACKAGE_ENTRIES,
  MAX_PWA_SHELL_BYTES,
  createPrecacheManifest,
  filePathToPublicUrl,
} from "./pwa-build-core.mjs";
import {
  assertPrivacyManifest,
  scanPrivacySourceFile,
} from "./privacy-manifest-core.mjs";
import { validatePrivacyContentSecurityPolicy } from "./privacy-csp-core.mjs";

const dist = new URL("../dist/", import.meta.url);
const distPath = fileURLToPath(dist);
const sourcePath = fileURLToPath(new URL("../src/", import.meta.url));
const basePath = "/online-tools-hub/";
const maximumToolScriptGzipBytes = 100 * 1024;

const requiredRoutes = [
  "index.html",
  "404.html",
  "offline.html",
  "service-worker.js",
  "manifest.webmanifest",
  "privacy-manifest.json",
  "icons/app-icon-192.png",
  "icons/app-icon-512.png",
  "icons/app-icon-maskable-512.png",
  "THIRD_PARTY_NOTICES.txt",
  "privacy/index.html",
  "changelog/index.html",
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
  "workflows/index.html",
  "workflows/base64-json-inspect/index.html",
  "workflows/yaml-config-to-base64url/index.html",
  "workflows/csv-api-fixture-sha256/index.html",
  "workflows/encoded-callback-query-audit/index.html",
  "workflows/encoded-jwt-claims/index.html",
  "workflows/png-palette-sha256/index.html",
  "guides/index.html",
  "guides/base64-is-not-encryption/index.html",
  "guides/jwt-decode-vs-verify/index.html",
  "guides/verify-file-sha256/index.html",
  "guides/csv-json-data-safety/index.html",
  "guides/image-compression-quality-size/index.html",
  "guides/yaml-json-differences/index.html",
  "guides/url-query-parameters/index.html",
  "guides/local-browser-tools-privacy/index.html",
  "__runtime/workflows/index.html",
];

const expectedToolIds = Object.freeze(
  [
    "json-formatter",
    "base64-codec",
    "url-codec",
    "unix-timestamp",
    "uuid-generator",
    "image-compressor",
    "text-diff",
    "hash-generator",
    "yaml-json-converter",
    "jwt-decoder",
    "csv-json-converter",
    "query-params",
  ].sort((left, right) => left.localeCompare(right, "en")),
);

const expectedOperationIds = Object.freeze(
  [
    "json.transform",
    "base64.codec",
    "url.codec",
    "timestamp.convert",
    "uuid.generate",
    "image.rgba-to-png",
    "text.diff",
    "hash.digest",
    "yaml.convert",
    "jwt.decode",
    "csv.convert",
    "query.inspect",
  ].sort((left, right) => left.localeCompare(right, "en")),
);

const expectedWorkflowIds = Object.freeze(
  [
    "base64-json-inspect",
    "yaml-config-to-base64url",
    "csv-api-fixture-sha256",
    "encoded-callback-query-audit",
    "encoded-jwt-claims",
    "png-palette-sha256",
  ].sort((left, right) => left.localeCompare(right, "en")),
);

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

function assertOrderedIds(actual, expected, label) {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${label} 必须按注册表稳定顺序完整覆盖 ${expected.length} 项`,
  );
}

const privacySourceIssues = [];
for (const file of (await collectFiles(sourcePath)).filter(
  (entry) =>
    /\.(?:astro|[cm]?[jt]sx?)$/u.test(entry) && !entry.endsWith(".d.ts"),
)) {
  const relative = path
    .relative(fileURLToPath(new URL("../", import.meta.url)), file)
    .split(path.sep)
    .join("/");
  privacySourceIssues.push(
    ...scanPrivacySourceFile(relative, await readFile(file, "utf8")),
  );
}
assert(
  privacySourceIssues.length === 0,
  `源码隐私门禁失败：${privacySourceIssues.join(", ")}`,
);

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
assert(homepage.includes(`${basePath}workflows/`), "首页缺少公开工作流入口");
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
assert(changelog.includes("1.0.0"), "更新日志缺少 1.0.0 记录");

const workflowRuntime = await readFile(
  new URL("__runtime/workflows/index.html", dist),
  "utf8",
);
assert(
  /<meta name="robots" content="noindex, nofollow">/u.test(workflowRuntime),
  "Workflow Runtime 验收路由必须 noindex",
);
assert(
  !/<link rel="canonical"/u.test(workflowRuntime),
  "Workflow Runtime 验收路由不得发布 canonical",
);

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

const privacyManifest = JSON.parse(
  await readFile(new URL("privacy-manifest.json", dist), "utf8"),
);
assertPrivacyManifest(privacyManifest);
assertOrderedIds(
  privacyManifest.inventory.tools.map((tool) => tool.id),
  expectedToolIds,
  "隐私清单工具 inventory",
);
assertOrderedIds(
  privacyManifest.inventory.operations.map((operation) => operation.id),
  expectedOperationIds,
  "隐私清单 Operation inventory",
);
assertOrderedIds(
  privacyManifest.inventory.workflows.map((workflow) => workflow.id),
  expectedWorkflowIds,
  "隐私清单 Workflow inventory",
);
assert(
  JSON.stringify(privacyManifest.allowedState) ===
    JSON.stringify([
      {
        id: "theme-preference",
        storage: "local-storage",
        key: "online-tools-hub:theme",
        mayContainUserContent: false,
      },
      {
        id: "tool-memory",
        storage: "local-storage",
        key: "online-tools-hub:tool-memory:v1",
        fields: ["version", "favorites", "recent", "slug", "at"],
        mayContainUserContent: false,
      },
      {
        id: "public-static-build-assets",
        storage: "cache-storage",
        mayContainUserContent: false,
        constraints: {
          origin: "same-origin",
          method: "GET",
          query: "forbidden",
          source: "build-allowlist",
        },
      },
      {
        id: "service-worker-registration",
        storage: "service-worker-registration",
        scope: "site-base",
        script: "same-origin-build-artifact",
        mayContainUserContent: false,
      },
    ]),
  "隐私清单只能声明主题、工具快捷元数据、公开构建缓存与站点 Service Worker 注册四类非正文状态",
);
for (const tool of privacyManifest.inventory.tools) {
  assert(
    tool.route === `tools/${tool.id}/`,
    `隐私清单工具路由与 ID 不一致：${tool.id}`,
  );
}

const privacyPage = await readFile(new URL("privacy/index.html", dist), "utf8");
assert(
  privacyPage.includes("隐私与能力中心") &&
    privacyPage.includes("data-privacy-self-test") &&
    privacyPage.includes("data-pwa-offline-trigger"),
  "隐私页缺少能力中心、自检或离线包入口",
);
assert(
  privacyPage.includes(
    "自检只观察当前版本本站代码在本标签页内执行一组随机合成数据时的行为。它会读取 IndexedDB 数据库名称，但不读取其中的记录值；也不检查浏览器扩展、浏览器实现、操作系统、网络设备、托管平台日志、其他标签页或本次未执行的路径。通过不等于第三方安全认证。",
  ),
  "隐私能力中心缺少完整、非认证式的自检边界说明",
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
  serviceWorker.includes("await cache.put(canonicalEntryRequest(entry)") &&
    serviceWorker.includes("crypto.subtle.digest") &&
    serviceWorker.includes("PACKAGE_ENTRY_BY_URL") &&
    serviceWorker.includes('request.method !== "GET"') &&
    serviceWorker.includes("url.origin !== self.location.origin") &&
    serviceWorker.includes("url.pathname.startsWith(BASE_PATH)") &&
    serviceWorker.includes('details.url.search === ""') &&
    serviceWorker.includes('request.destination !== ""') &&
    serviceWorker.includes('request.headers.has("authorization")') &&
    serviceWorker.includes('request.headers.has("range")'),
  "Service Worker 缺少同源 GET、无 query、构建白名单与完整性校验写入边界",
);
for (const requiredWorkerMarker of [
  "SHELL_CACHE_PREFIX",
  "CONTENT_CACHE_PREFIX",
  'status: "PWA_OFFLINE_STATUS"',
  'start: "PWA_OFFLINE_PACKAGE_START"',
  'cancel: "PWA_OFFLINE_PACKAGE_CANCEL"',
  'remove: "PWA_OFFLINE_PACKAGE_REMOVE"',
]) {
  assert(
    serviceWorker.includes(requiredWorkerMarker),
    `Service Worker 缺少离线包协议标记：${requiredWorkerMarker}`,
  );
}
assert(
  !serviceWorker.includes('addEventListener("sync"') &&
    !serviceWorker.includes('addEventListener("push"'),
  "Service Worker 不得启用后台同步或推送",
);
assert(
  !serviceWorker.includes("cache.addAll(") &&
    !serviceWorker.includes("Promise.all(PACKAGE_ENTRIES"),
  "Service Worker 不得在安装时并发预缓存完整离线包",
);
assert(
  serviceWorker.includes("async function verifiedCachedEntryResponse(") &&
    serviceWorker.includes(
      "await verifyEntryResponse(cached.clone(), entry, signal)",
    ) &&
    serviceWorker.includes("await deleteCachedEntry(entry)"),
  "Service Worker 缓存读取必须重新校验字节数与 SHA-256，并删除无效条目",
);
for (const verifiedCacheRead of [
  "return (await verifiedCachedEntryResponse(entry)) ?? Response.error()",
  "const cached = await verifiedCachedEntryResponse(entry)",
]) {
  assert(
    serviceWorker.includes(verifiedCacheRead),
    `Service Worker 缺少已验证缓存读取：${verifiedCacheRead}`,
  );
}
assert(
  /async function offlineFallback\([\s\S]*?verifiedCachedEntryResponse\(/u.test(
    serviceWorker,
  ) &&
    /async function respondToNavigation\([\s\S]*?verifiedCachedEntryResponse\(/u.test(
      serviceWorker,
    ) &&
    /async function respondToStaticRequest\([\s\S]*?verifiedCachedEntryResponse\(/u.test(
      serviceWorker,
    ),
  "离线回退、导航与静态资源缓存命中都必须走完整性复验",
);

const packageEntriesSource = serviceWorker.match(
  /const PACKAGE_ENTRIES = Object\.freeze\((\[[\s\S]*?\])\.map\(Object\.freeze\)\);/u,
)?.[1];
const shellUrlsSource = serviceWorker.match(
  /const SHELL_URLS = Object\.freeze\((\[[\s\S]*?\])\);/u,
)?.[1];
const buildVersion = serviceWorker.match(
  /const BUILD_VERSION = "([a-f\d]{16})";/u,
)?.[1];
assert(packageEntriesSource, "Service Worker 缺少可验证的完整离线包清单");
assert(shellUrlsSource, "Service Worker 缺少可验证的最小应用壳清单");
assert(buildVersion, "Service Worker 缺少内容寻址构建版本");

const packageEntries = JSON.parse(packageEntriesSource);
const shellUrls = JSON.parse(shellUrlsSource);
const expectedPwaManifest = await createPrecacheManifest(distPath, basePath);
assert(
  JSON.stringify(packageEntries) ===
    JSON.stringify(expectedPwaManifest.entries),
  "Service Worker 完整离线包与生产构建的字节数/SHA-256 清单不一致",
);
assert(
  JSON.stringify(shellUrls) === JSON.stringify(expectedPwaManifest.shellUrls),
  "Service Worker 最小应用壳与首页真实资源闭包不一致",
);
assert(
  buildVersion === expectedPwaManifest.version,
  "Service Worker 构建版本与生产资源清单不一致",
);
assert(
  packageEntries.length <= MAX_PWA_PACKAGE_ENTRIES &&
    expectedPwaManifest.totalBytes <= MAX_PWA_PACKAGE_BYTES,
  "完整离线包超过构建硬上限",
);
assert(
  expectedPwaManifest.shellBytes <= MAX_PWA_SHELL_BYTES,
  "最小应用壳超过 2 MiB 构建硬上限",
);

const packageUrls = new Set(packageEntries.map((entry) => entry.url));
const shellUrlSet = new Set(shellUrls);
const packageKinds = new Set([
  "document",
  "style",
  "script",
  "font",
  "image",
  "manifest",
  "wasm",
  "data",
]);
for (const entry of packageEntries) {
  assert(
    entry.url.startsWith(basePath),
    `离线包资源逃逸部署 base：${entry.url}`,
  );
  assert(
    !/[?#]/u.test(entry.url),
    `离线包资源不得包含 query/hash：${entry.url}`,
  );
  assert(
    Number.isSafeInteger(entry.bytes) &&
      entry.bytes >= 0 &&
      entry.bytes <= MAX_PWA_ENTRY_BYTES,
    `离线包资源字节数无效：${entry.url}`,
  );
  assert(
    /^[a-f\d]{64}$/u.test(entry.sha256),
    `离线包资源 SHA-256 无效：${entry.url}`,
  );
  assert(packageKinds.has(entry.kind), `离线包资源类型无效：${entry.url}`);
}
assert(packageUrls.size === packageEntries.length, "完整离线包 URL 必须唯一");
assert(shellUrlSet.size === shellUrls.length, "最小应用壳 URL 必须唯一");
assert(
  [...shellUrlSet].every((url) => packageUrls.has(url)),
  "最小应用壳必须是完整离线包白名单的真子集",
);
assert(
  shellUrls.length < packageEntries.length,
  "安装阶段不得把完整离线包退化为整站预缓存",
);
for (const requiredShellPath of [
  "index.html",
  "offline.html",
  "manifest.webmanifest",
  "privacy-manifest.json",
  "icons/app-icon-192.png",
  "icons/app-icon-512.png",
  "icons/app-icon-maskable-512.png",
]) {
  const url = filePathToPublicUrl(requiredShellPath, basePath);
  assert(shellUrlSet.has(url), `最小应用壳缺少 ${url}`);
}
assert(
  !shellUrls.some((url) => /\/(?:tools|workflows|guides)\//u.test(url)),
  "最小应用壳不得预缓存工具、工作流或指南页面",
);

for (const route of requiredRoutes.filter(
  (route) =>
    route !== "service-worker.js" &&
    !(route.startsWith("__runtime/") && route.endsWith(".html")),
)) {
  const publicUrl = filePathToPublicUrl(route, basePath);
  assert(packageUrls.has(publicUrl), `完整离线包缺少公开资源 ${publicUrl}`);
}
assert(
  !packageUrls.has(`${basePath}__runtime/workflows/`),
  "完整离线包不得发布隐藏 Workflow 验收路由",
);
assert(
  !packageUrls.has(`${basePath}__runtime/operations/`) &&
    !packageUrls.has(`${basePath}service-worker.js`) &&
    ![...packageUrls].some((url) => url.endsWith(".map")),
  "完整离线包不得包含隐藏验收路由、Service Worker 或 source map",
);

for (const route of requiredRoutes.filter((route) =>
  route.startsWith("workflows/"),
)) {
  const html = await readFile(new URL(route, dist), "utf8");
  assert(html.includes("浏览器本地"), `${route} 缺少本地处理边界`);
  assert(html.includes("配方不含正文"), `${route} 缺少配方隐私边界`);
  assert(html.includes('rel="canonical"'), `${route} 缺少公开页面 canonical`);
  assert(!html.includes("noindex, nofollow"), `${route} 不得标记 noindex`);
  if (route === "workflows/index.html") {
    assert(
      html.includes('"@type":"CollectionPage"'),
      `${route} 缺少 CollectionPage 结构化数据`,
    );
    assert(
      html.includes('"@type":"ItemList"'),
      `${route} 缺少 ItemList 结构化数据`,
    );
  } else {
    assert(
      html.includes('"@type":"SoftwareApplication"'),
      `${route} 缺少 SoftwareApplication 结构化数据`,
    );
    assert(html.includes('"@type":"HowTo"'), `${route} 缺少 HowTo 结构化数据`);
    assert(
      html.includes('"@type":"BreadcrumbList"'),
      `${route} 缺少 Breadcrumb 结构化数据`,
    );
  }
}

for (const route of requiredRoutes.filter(
  (route) => route.startsWith("tools/") && route !== "tools/index.html",
)) {
  const html = await readFile(new URL(route, dist), "utf8");
  assert(html.includes("实际场景"), `${route} 缺少实际使用场景`);
  assert(
    html.includes('"softwareVersion":"1.0.0"'),
    `${route} 的结构化数据版本不是 1.0.0`,
  );
}

const allFiles = await collectFiles(distPath);
const htmlFiles = allFiles.filter((file) => file.endsWith(".html"));
const scriptFiles = allFiles.filter((file) => file.endsWith(".js"));
const resourceGraphs = [];

const publicEnglishRoutes = htmlFiles
  .map((file) => path.relative(distPath, file).split(path.sep).join("/"))
  .filter((route) => route === "en/index.html" || route.startsWith("en/"));
assert(
  publicEnglishRoutes.length === 0,
  `v1.0 不得发布未完成的英文路由：${publicEnglishRoutes.join(", ")}`,
);

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
  const cspValidation = validatePrivacyContentSecurityPolicy(
    csp,
    privacyManifest.enforcement.csp.requiredDirectives,
  );
  assert(
    cspValidation.ok,
    `${relative} 的 CSP 不符合严格隐私策略：${
      cspValidation.ok ? "" : cspValidation.issues.join(", ")
    }`,
  );
  if (relative !== "offline.html") {
    assert(
      html.includes(
        `<link rel="alternate" type="application/json" title="Privacy manifest" href="${basePath}privacy-manifest.json">`,
      ),
      `${relative} 缺少机器可发现的隐私清单链接`,
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
assert(!sitemap.includes(`${basePath}en/`), "sitemap 不得包含未完成的英文路由");
for (const route of requiredRoutes.filter(
  (route) =>
    route.startsWith("tools/") ||
    route.startsWith("guides/") ||
    route.startsWith("workflows/"),
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

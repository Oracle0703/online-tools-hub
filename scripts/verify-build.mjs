import { gzipSync } from "node:zlib";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const dist = new URL("../dist/", import.meta.url);
const basePath = "/online-tools-hub/";
const maximumInitialGzipBytes = 200 * 1024;
const maximumToolScriptGzipBytes = 100 * 1024;

const requiredRoutes = [
  "index.html",
  "404.html",
  "privacy/index.html",
  "tools/index.html",
  "tools/json-formatter/index.html",
  "tools/base64-codec/index.html",
  "tools/url-codec/index.html",
  "tools/unix-timestamp/index.html",
  "tools/uuid-generator/index.html",
  "tools/image-compressor/index.html",
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

function assetPaths(html) {
  return new Set(
    [
      ...html.matchAll(
        /(?:src|href)="(\/online-tools-hub\/[^"?#]+\.(?:css|js))"/gu,
      ),
    ]
      .map((match) => match[1])
      .filter(Boolean),
  );
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

const allFiles = await collectFiles(dist.pathname);
const htmlFiles = allFiles.filter((file) => file.endsWith(".html"));
const scriptFiles = allFiles.filter((file) => file.endsWith(".js"));

for (const file of htmlFiles) {
  const relative = path.relative(dist.pathname, file);
  const html = await readFile(file, "utf8");
  const cspMatches = [
    ...html.matchAll(
      /<meta http-equiv="content-security-policy" content="([^"]+)">/gu,
    ),
  ];
  const csp = cspMatches[0]?.[1];

  assert(csp, `${relative} 缺少构建期 meta CSP`);
  assert(cspMatches.length === 1, `${relative} 必须且只能包含一个 meta CSP`);
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

  let initialBytes = gzipSync(html).byteLength;
  for (const assetPath of assetPaths(html)) {
    const relativeAsset = assetPath.slice(basePath.length);
    const assetUrl = new URL(relativeAsset, dist);
    const asset = await readFile(assetUrl);
    initialBytes += gzipSync(asset).byteLength;
  }

  assert(
    initialBytes <= maximumInitialGzipBytes,
    `${relative} 首屏 gzip 资源 ${initialBytes} B 超过 ${maximumInitialGzipBytes} B`,
  );
}

for (const file of scriptFiles) {
  const gzipBytes = gzipSync(await readFile(file)).byteLength;
  assert(
    gzipBytes <= maximumToolScriptGzipBytes,
    `${path.relative(dist.pathname, file)} gzip 后 ${gzipBytes} B 超过 ${maximumToolScriptGzipBytes} B`,
  );
}

const sitemap = await readFile(new URL("sitemap.xml", dist), "utf8");
for (const route of requiredRoutes.filter((route) =>
  route.startsWith("tools/"),
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

import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { buildPageResourceGraph } from "./build-resource-graph.mjs";
import {
  PWA_OFFLINE_PROTOCOL_VERSION,
  createServiceWorkerSource,
} from "./pwa-service-worker-source.mjs";

export { PWA_OFFLINE_PROTOCOL_VERSION, createServiceWorkerSource };

export const MAX_PWA_PACKAGE_ENTRIES = 512;
export const MAX_PWA_PACKAGE_BYTES = 64 * 1024 * 1024;
export const MAX_PWA_ENTRY_BYTES = 16 * 1024 * 1024;
export const MAX_PWA_SHELL_BYTES = 2 * 1024 * 1024;

const cacheableExtensions = new Set([
  ".avif",
  ".css",
  ".gif",
  ".html",
  ".ico",
  ".jpeg",
  ".jpg",
  ".js",
  ".json",
  ".png",
  ".svg",
  ".txt",
  ".wasm",
  ".webmanifest",
  ".webp",
  ".woff",
  ".woff2",
  ".xml",
]);

const fixedShellPaths = Object.freeze([
  "index.html",
  "offline.html",
  "offline.css",
  "manifest.webmanifest",
  "privacy-manifest.json",
  "favicon.svg",
  "icons/app-icon-192.png",
  "icons/app-icon-512.png",
  "icons/app-icon-maskable-512.png",
]);

function normalizeRelativePath(value) {
  const normalized = String(value).split(path.sep).join("/");
  if (
    normalized === "" ||
    normalized.startsWith("/") ||
    normalized.endsWith("/") ||
    normalized.includes("\\") ||
    normalized.includes("?") ||
    normalized.includes("#") ||
    [...normalized].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f;
    })
  ) {
    throw new TypeError(`Unsafe build output path: ${value}`);
  }
  const segments = normalized.split("/");
  if (
    segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    )
  ) {
    throw new TypeError(`Unsafe build output path: ${value}`);
  }
  return normalized;
}

function encodePublicPath(relativePath) {
  return normalizeRelativePath(relativePath)
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

export function normalizeBasePath(value) {
  const pathname = String(value || "/").split(/[?#]/u, 1)[0] ?? "/";
  const normalized = `/${pathname}`.replace(/\/{2,}/gu, "/");
  const stripped = normalized.replace(/^\/+|\/+$/gu, "");
  return stripped ? `/${stripped}/` : "/";
}

export function filePathToPublicUrl(relativePath, basePath) {
  const normalizedBase = normalizeBasePath(basePath);
  const normalizedFile = encodePublicPath(relativePath);

  if (normalizedFile === "index.html") return normalizedBase;
  if (normalizedFile.endsWith("/index.html")) {
    return `${normalizedBase}${normalizedFile.slice(0, -"index.html".length)}`;
  }
  return `${normalizedBase}${normalizedFile}`;
}

/** Whether a build output is eligible for the public offline package. */
export function shouldPrecache(relativePath) {
  const normalized = normalizeRelativePath(relativePath);
  if (
    normalized === "service-worker.js" ||
    normalized.endsWith(".map") ||
    normalized.startsWith("playwright-report/") ||
    normalized.startsWith("test-results/") ||
    (normalized.startsWith("__runtime/") && normalized.endsWith(".html"))
  ) {
    return false;
  }
  return cacheableExtensions.has(path.posix.extname(normalized));
}

async function collectFiles(directory, root = directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(absolutePath, root)));
    } else if (entry.isFile()) {
      files.push(normalizeRelativePath(path.relative(root, absolutePath)));
    }
  }

  return files;
}

function entryKind(relativePath) {
  if (relativePath === "index.html" || relativePath.endsWith("/index.html")) {
    return "document";
  }
  switch (path.posix.extname(relativePath)) {
    case ".html":
      return "document";
    case ".css":
      return "style";
    case ".js":
      return "script";
    case ".woff":
    case ".woff2":
      return "font";
    case ".avif":
    case ".gif":
    case ".ico":
    case ".jpeg":
    case ".jpg":
    case ".png":
    case ".svg":
    case ".webp":
      return "image";
    case ".webmanifest":
      return "manifest";
    case ".wasm":
      return "wasm";
    default:
      return "data";
  }
}

function assertWithinPackageLimits(entries) {
  if (entries.length > MAX_PWA_PACKAGE_ENTRIES) {
    throw new Error(
      `PWA 离线包包含 ${entries.length} 项，超过 ${MAX_PWA_PACKAGE_ENTRIES} 项上限。`,
    );
  }

  let totalBytes = 0;
  for (const entry of entries) {
    if (entry.bytes > MAX_PWA_ENTRY_BYTES) {
      throw new Error(
        `PWA 离线资源 ${entry.relativePath} 为 ${entry.bytes} B，超过 ${MAX_PWA_ENTRY_BYTES} B 单项上限。`,
      );
    }
    if (totalBytes > MAX_PWA_PACKAGE_BYTES - entry.bytes) {
      throw new Error(`PWA 离线包超过 ${MAX_PWA_PACKAGE_BYTES} B 总量上限。`);
    }
    totalBytes += entry.bytes;
  }
  return totalBytes;
}

async function createPackageEntries(distDirectory, basePath) {
  const relativePaths = (await collectFiles(distDirectory))
    .filter(shouldPrecache)
    .sort((left, right) => left.localeCompare(right, "en"));
  if (relativePaths.length === 0) {
    throw new Error("PWA 离线包没有可缓存的公开构建资源。");
  }
  if (relativePaths.length > MAX_PWA_PACKAGE_ENTRIES) {
    throw new Error(
      `PWA 离线包包含 ${relativePaths.length} 项，超过 ${MAX_PWA_PACKAGE_ENTRIES} 项上限。`,
    );
  }

  const entries = [];
  for (const relativePath of relativePaths) {
    const body = await readFile(path.join(distDirectory, relativePath));
    entries.push({
      relativePath,
      url: filePathToPublicUrl(relativePath, basePath),
      bytes: body.byteLength,
      sha256: createHash("sha256").update(body).digest("hex"),
      kind: entryKind(relativePath),
    });
  }
  return entries;
}

async function collectShellPaths(distDirectory, packagePathSet, basePath) {
  const shellPaths = new Set(fixedShellPaths);
  const homepage = await readFile(path.join(distDirectory, "index.html"));
  const graph = await buildPageResourceGraph({
    route: "index.html",
    html: homepage,
    basePath,
    loadAsset: (assetPath) => readFile(path.join(distDirectory, assetPath)),
    gzipSize: () => 0,
  });
  for (const asset of graph.assets) shellPaths.add(asset.path);

  for (const relativePath of shellPaths) {
    if (!packagePathSet.has(relativePath)) {
      throw new Error(`PWA 最小应用壳缺少构建资源：${relativePath}`);
    }
  }
  return shellPaths;
}

function createBuildVersion(basePath, entries, shellUrls) {
  const hash = createHash("sha256");
  hash.update(PWA_OFFLINE_PROTOCOL_VERSION.toString());
  hash.update("\0");
  hash.update(basePath);
  hash.update("\0");
  for (const entry of entries) {
    hash.update(entry.relativePath);
    hash.update("\0");
    hash.update(entry.bytes.toString());
    hash.update("\0");
    hash.update(entry.sha256);
    hash.update("\0");
  }
  for (const shellUrl of shellUrls) {
    hash.update("shell\0");
    hash.update(shellUrl);
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 16);
}

function publicEntry(entry) {
  return Object.freeze({
    url: entry.url,
    bytes: entry.bytes,
    sha256: entry.sha256,
    kind: entry.kind,
  });
}

/**
 * Create the complete, content-addressed offline manifest. The legacy function
 * name is retained because build and verification callers already import it.
 */
export async function createPrecacheManifest(distDirectory, basePath) {
  const normalizedBase = normalizeBasePath(basePath);
  const internalEntries = await createPackageEntries(
    distDirectory,
    normalizedBase,
  );
  const totalBytes = assertWithinPackageLimits(internalEntries);
  const packagePathSet = new Set(
    internalEntries.map((entry) => entry.relativePath),
  );
  const shellPaths = await collectShellPaths(
    distDirectory,
    packagePathSet,
    normalizedBase,
  );
  const entries = internalEntries.map(publicEntry);
  const shellEntries = internalEntries
    .filter((entry) => shellPaths.has(entry.relativePath))
    .map(publicEntry);
  const shellBytes = shellEntries.reduce(
    (total, entry) => total + entry.bytes,
    0,
  );
  if (shellBytes > MAX_PWA_SHELL_BYTES) {
    throw new Error(
      `PWA 最小应用壳为 ${shellBytes} B，超过 ${MAX_PWA_SHELL_BYTES} B 上限。`,
    );
  }
  const urls = Object.freeze(entries.map((entry) => entry.url));
  const shellUrls = Object.freeze(shellEntries.map((entry) => entry.url));
  const version = createBuildVersion(
    normalizedBase,
    internalEntries,
    shellUrls,
  );

  return Object.freeze({
    protocolVersion: PWA_OFFLINE_PROTOCOL_VERSION,
    version,
    basePath: normalizedBase,
    entries: Object.freeze(entries),
    shellEntries: Object.freeze(shellEntries),
    urls,
    shellUrls,
    totalBytes,
    shellBytes,
  });
}

export async function generateServiceWorker({ distDirectory, basePath }) {
  const manifest = await createPrecacheManifest(distDirectory, basePath);
  const source = createServiceWorkerSource({
    basePath: manifest.basePath,
    version: manifest.version,
    entries: manifest.entries,
    shellUrls: manifest.shellUrls,
  });
  const destination = path.join(distDirectory, "service-worker.js");
  await writeFile(destination, source, "utf8");
  return Object.freeze({ ...manifest, destination });
}

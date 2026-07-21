import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  canRegisterServiceWorker,
  normalizeBaseUrl,
  pwaAssetUrl,
} from "../../src/lib/pwa";
import {
  MAX_PWA_ENTRY_BYTES,
  MAX_PWA_PACKAGE_BYTES,
  MAX_PWA_PACKAGE_ENTRIES,
  MAX_PWA_SHELL_BYTES,
  PWA_OFFLINE_PROTOCOL_VERSION,
  createPrecacheManifest,
  createServiceWorkerSource,
  filePathToPublicUrl,
  normalizeBasePath,
  shouldPrecache,
} from "../../scripts/pwa-build-core.mjs";

const temporaryDirectories: string[] = [];

async function createPwaFixture(directory: string): Promise<void> {
  await mkdir(path.join(directory, "assets"), { recursive: true });
  await mkdir(path.join(directory, "icons"), { recursive: true });
  await mkdir(path.join(directory, "tools", "fixture"), { recursive: true });
  await mkdir(path.join(directory, "__runtime", "private"), {
    recursive: true,
  });
  await writeFile(
    path.join(directory, "index.html"),
    '<link rel="stylesheet" href="/online-tools-hub/assets/app.css"><script src="/online-tools-hub/assets/app.js"></script>',
  );
  await writeFile(path.join(directory, "offline.html"), "<h1>Offline</h1>");
  await writeFile(path.join(directory, "offline.css"), "body{color:#fff}");
  await writeFile(path.join(directory, "manifest.webmanifest"), "{}");
  await writeFile(path.join(directory, "privacy-manifest.json"), "{}");
  await writeFile(path.join(directory, "favicon.svg"), "<svg></svg>");
  await writeFile(
    path.join(directory, "icons", "app-icon-192.png"),
    "icon-192",
  );
  await writeFile(
    path.join(directory, "icons", "app-icon-512.png"),
    "icon-512",
  );
  await writeFile(
    path.join(directory, "icons", "app-icon-maskable-512.png"),
    "icon-maskable",
  );
  await writeFile(path.join(directory, "assets", "app.css"), "body{}");
  await writeFile(path.join(directory, "assets", "app.js"), "export {};");
  await writeFile(
    path.join(directory, "tools", "fixture", "index.html"),
    "<h1>Tool</h1>",
  );
  await writeFile(
    path.join(directory, "__runtime", "private", "index.html"),
    "<h1>Internal</h1>",
  );
  await writeFile(path.join(directory, "private.bin"), "do-not-cache");
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("PWA runtime paths", () => {
  it.each([
    ["/online-tools-hub", "/online-tools-hub/"],
    ["online-tools-hub/", "/online-tools-hub/"],
    ["//online-tools-hub///", "/online-tools-hub/"],
    ["/online-tools-hub/?preview=true", "/online-tools-hub/"],
    ["/", "/"],
    ["", "/"],
  ])("normalizes %s to a scoped base URL", (input, expected) => {
    expect(normalizeBaseUrl(input)).toBe(expected);
    expect(normalizeBasePath(input)).toBe(expected);
  });

  it("joins service-worker assets without escaping the repository scope", () => {
    expect(pwaAssetUrl("/online-tools-hub", "/service-worker.js/")).toBe(
      "/online-tools-hub/service-worker.js",
    );
  });

  it("registers only when service workers are available in a safe context", () => {
    expect(
      canRegisterServiceWorker({
        hasServiceWorker: true,
        isSecureContext: true,
        hostname: "oracle0703.github.io",
      }),
    ).toBe(true);
    expect(
      canRegisterServiceWorker({
        hasServiceWorker: true,
        isSecureContext: false,
        hostname: "localhost",
      }),
    ).toBe(true);
    expect(
      canRegisterServiceWorker({
        hasServiceWorker: true,
        isSecureContext: false,
        hostname: "127.0.0.1",
      }),
    ).toBe(true);
    expect(
      canRegisterServiceWorker({
        hasServiceWorker: false,
        isSecureContext: true,
        hostname: "oracle0703.github.io",
      }),
    ).toBe(false);
    expect(
      canRegisterServiceWorker({
        hasServiceWorker: true,
        isSecureContext: false,
        hostname: "example.test",
      }),
    ).toBe(false);
  });
});

describe("PWA build manifest", () => {
  it("maps output files to GitHub Pages URLs", () => {
    expect(filePathToPublicUrl("index.html", "/online-tools-hub")).toBe(
      "/online-tools-hub/",
    );
    expect(
      filePathToPublicUrl(
        path.join("tools", "json-formatter", "index.html"),
        "/online-tools-hub/",
      ),
    ).toBe("/online-tools-hub/tools/json-formatter/");
    expect(
      filePathToPublicUrl("assets/client.abc.js", "/online-tools-hub/"),
    ).toBe("/online-tools-hub/assets/client.abc.js");
    expect(
      filePathToPublicUrl("assets/file name.js", "/online-tools-hub/"),
    ).toBe("/online-tools-hub/assets/file%20name.js");
    expect(() =>
      filePathToPublicUrl("../private.js", "/online-tools-hub/"),
    ).toThrow("Unsafe build output path");
  });

  it("selects only public package formats and excludes private build output", () => {
    for (const filename of [
      "index.html",
      "assets/app.js",
      "assets/app.css",
      "manifest.webmanifest",
      "icons/app.png",
      "assets/photo.webp",
      "assets/runtime.wasm",
      "assets/font.woff2",
      "favicon.svg",
      "sitemap.xml",
      "THIRD_PARTY_NOTICES.txt",
    ]) {
      expect(shouldPrecache(filename)).toBe(true);
    }
    for (const filename of [
      "service-worker.js",
      "assets/app.js.map",
      "playwright-report/index.html",
      "test-results/result.json",
      "__runtime/workflows/index.html",
      "__runtime/operations/index.html",
      "notes.md",
    ]) {
      expect(shouldPrecache(filename)).toBe(false);
    }
  });

  it("creates a stable content manifest and a strict minimal shell", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "tools-hub-pwa-"));
    temporaryDirectories.push(directory);
    await createPwaFixture(directory);

    const first = await createPrecacheManifest(directory, "/online-tools-hub/");
    const second = await createPrecacheManifest(
      directory,
      "/online-tools-hub/",
    );
    expect(second).toEqual(first);
    expect(first.protocolVersion).toBe(1);
    expect(first.entries).toHaveLength(12);
    expect(first.urls).toEqual(
      expect.arrayContaining([
        "/online-tools-hub/",
        "/online-tools-hub/offline.html",
        "/online-tools-hub/assets/app.css",
        "/online-tools-hub/assets/app.js",
        "/online-tools-hub/tools/fixture/",
      ]),
    );
    expect(first.urls).not.toContain("/online-tools-hub/__runtime/private/");
    expect(first.shellUrls).toEqual(
      expect.arrayContaining([
        "/online-tools-hub/",
        "/online-tools-hub/offline.html",
        "/online-tools-hub/assets/app.css",
        "/online-tools-hub/assets/app.js",
      ]),
    );
    expect(first.shellUrls).not.toContain("/online-tools-hub/tools/fixture/");
    expect(first.shellUrls.length).toBeLessThan(first.urls.length);
    expect(first.shellBytes).toBeLessThanOrEqual(MAX_PWA_SHELL_BYTES);
    expect(first.totalBytes).toBeLessThanOrEqual(MAX_PWA_PACKAGE_BYTES);
    expect(first.version).toMatch(/^[a-f\d]{16}$/u);
    const scriptEntry = first.entries.find((entry) =>
      entry.url.endsWith("/assets/app.js"),
    );
    expect(scriptEntry).toEqual({
      url: "/online-tools-hub/assets/app.js",
      bytes: Buffer.byteLength("export {};"),
      sha256: createHash("sha256").update("export {};").digest("hex"),
      kind: "script",
    });
    expect(first.totalBytes).toBe(
      first.entries.reduce((total, entry) => total + entry.bytes, 0),
    );

    await writeFile(path.join(directory, "assets", "app.js"), "export { 1 };");
    const changed = await createPrecacheManifest(
      directory,
      "/online-tools-hub/",
    );
    expect(changed.version).not.toBe(first.version);
  });

  it("enforces package and shell hard limits before generation", async () => {
    expect(PWA_OFFLINE_PROTOCOL_VERSION).toBe(1);
    expect(MAX_PWA_PACKAGE_ENTRIES).toBe(512);
    expect(MAX_PWA_ENTRY_BYTES).toBe(16 * 1024 * 1024);
    expect(MAX_PWA_PACKAGE_BYTES).toBe(64 * 1024 * 1024);
    expect(MAX_PWA_SHELL_BYTES).toBe(2 * 1024 * 1024);

    const directory = await mkdtemp(path.join(tmpdir(), "tools-hub-pwa-"));
    temporaryDirectories.push(directory);
    await createPwaFixture(directory);
    await writeFile(
      path.join(directory, "assets", "too-large.js"),
      Buffer.alloc(MAX_PWA_ENTRY_BYTES + 1),
    );
    await expect(
      createPrecacheManifest(directory, "/online-tools-hub/"),
    ).rejects.toThrow("单项上限");
  });

  it("generates a verified two-cache worker and resumable package protocol", () => {
    const hash = createHash("sha256").update("offline").digest("hex");
    const source = createServiceWorkerSource({
      basePath: "/online-tools-hub/",
      version: "0123456789abcdef",
      entries: [
        {
          url: "/online-tools-hub/",
          bytes: 7,
          sha256: hash,
          kind: "document",
        },
        {
          url: "/online-tools-hub/offline.html",
          bytes: 7,
          sha256: hash,
          kind: "document",
        },
        {
          url: "/online-tools-hub/assets/app.js",
          bytes: 7,
          sha256: hash,
          kind: "script",
        },
      ],
      shellUrls: ["/online-tools-hub/", "/online-tools-hub/offline.html"],
    });

    expect(source).toContain('const BASE_PATH = "/online-tools-hub/"');
    expect(source).toContain('data.type === "SKIP_WAITING"');
    expect(source).toContain('request.method !== "GET"');
    expect(source).toContain('cache: reload ? "reload" : "default"');
    expect(source).toContain("url.origin !== self.location.origin");
    expect(source).toContain('details.url.search === ""');
    expect(source).toContain('request.destination !== ""');
    expect(source).toContain("normalizedNavigationEntry");
    expect(source).toContain("SHELL_CACHE_PREFIX");
    expect(source).toContain("CONTENT_CACHE_PREFIX");
    expect(source).toContain("respondToNavigation");
    expect(source).toContain("crypto.subtle.digest");
    expect(source).toContain("responseUrl.pathname !== entry.url");
    expect(source).toContain("await cache.put(canonicalEntryRequest(entry)");
    expect(source).toContain('status: "PWA_OFFLINE_STATUS"');
    expect(source).toContain('start: "PWA_OFFLINE_PACKAGE_START"');
    expect(source).toContain('cancel: "PWA_OFFLINE_PACKAGE_CANCEL"');
    expect(source).toContain('remove: "PWA_OFFLINE_PACKAGE_REMOVE"');
    expect(source).toContain('phase: "checking"');
    expect(source).toContain('phase: "downloading"');
    expect(source).toContain('new OfflinePackageError("quota", true)');
    expect(source).not.toContain("cache.addAll(");
    expect(source).not.toContain("Promise.all(PACKAGE_ENTRIES");
    expect(source).not.toContain('addEventListener("sync"');
    expect(source).not.toContain('addEventListener("push"');
    expect(() => new Function(source)).not.toThrow();
  });

  it("requires an offline fallback in the shell and rejects unsafe entries", () => {
    const hash = "0".repeat(64);
    expect(() =>
      createServiceWorkerSource({
        basePath: "/online-tools-hub/",
        version: "0123456789abcdef",
        entries: [
          {
            url: "/online-tools-hub/",
            bytes: 1,
            sha256: hash,
            kind: "document",
          },
        ],
        shellUrls: ["/online-tools-hub/"],
      }),
    ).toThrow("离线回退页未进入最小应用壳");
    expect(() =>
      createServiceWorkerSource({
        basePath: "/online-tools-hub/",
        version: "0123456789abcdef",
        entries: [
          {
            url: "/online-tools-hub/offline.html?private=true",
            bytes: 1,
            sha256: hash,
            kind: "document",
          },
        ],
        shellUrls: ["/online-tools-hub/offline.html?private=true"],
      }),
    ).toThrow("invalid entry");
  });
});

describe("published PWA metadata", () => {
  it("uses installable PNG icons and a repository-scoped manifest", async () => {
    const manifest = JSON.parse(
      await readFile("public/manifest.webmanifest", "utf8"),
    ) as {
      id: string;
      start_url: string;
      scope: string;
      display_override: string[];
      icons: Array<{ src: string; sizes: string; purpose: string }>;
    };

    expect(manifest.id).toBe("/online-tools-hub/");
    expect(manifest.start_url).toBe("/online-tools-hub/");
    expect(manifest.scope).toBe("/online-tools-hub/");
    expect(manifest.display_override).toEqual(["standalone", "minimal-ui"]);
    expect(manifest.display_override).not.toContain("window-controls-overlay");
    expect(manifest.icons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sizes: "192x192", purpose: "any" }),
        expect.objectContaining({ sizes: "512x512", purpose: "any" }),
        expect.objectContaining({ sizes: "512x512", purpose: "maskable" }),
      ]),
    );

    for (const icon of manifest.icons) {
      const bytes = await readFile(
        `public${icon.src.replace("/online-tools-hub", "")}`,
      );
      expect(bytes.subarray(1, 4).toString("ascii")).toBe("PNG");
      const [width, height] = icon.sizes.split("x").map(Number);
      expect(bytes.readUInt32BE(16)).toBe(width);
      expect(bytes.readUInt32BE(20)).toBe(height);
    }
  });
});

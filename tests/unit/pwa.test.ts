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
  createPrecacheManifest,
  createServiceWorkerSource,
  filePathToPublicUrl,
  normalizeBasePath,
  shouldPrecache,
} from "../../scripts/pwa-build-core.mjs";

const temporaryDirectories: string[] = [];

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
  });

  it("selects only public static formats and excludes generated worker/maps", () => {
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
      "notes.md",
    ]) {
      expect(shouldPrecache(filename)).toBe(false);
    }
  });

  it("creates a stable, content-versioned allowlist", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "tools-hub-pwa-"));
    temporaryDirectories.push(directory);
    await mkdir(path.join(directory, "assets"));
    await writeFile(path.join(directory, "index.html"), "<h1>Home</h1>");
    await writeFile(path.join(directory, "offline.html"), "<h1>Offline</h1>");
    await writeFile(path.join(directory, "assets", "app.js"), "export {};");
    await writeFile(path.join(directory, "private.bin"), "do-not-cache");

    const first = await createPrecacheManifest(directory, "/online-tools-hub/");
    const second = await createPrecacheManifest(
      directory,
      "/online-tools-hub/",
    );
    expect(second).toEqual(first);
    expect(first.urls).toEqual([
      "/online-tools-hub/assets/app.js",
      "/online-tools-hub/",
      "/online-tools-hub/offline.html",
    ]);
    expect(first.version).toMatch(/^[a-f\d]{16}$/u);

    await writeFile(path.join(directory, "assets", "app.js"), "export { 1 };");
    const changed = await createPrecacheManifest(
      directory,
      "/online-tools-hub/",
    );
    expect(changed.version).not.toBe(first.version);
  });

  it("generates a cache-private worker with explicit update handling", () => {
    const source = createServiceWorkerSource({
      basePath: "/online-tools-hub/",
      version: "0123456789abcdef",
      urls: [
        "/online-tools-hub/",
        "/online-tools-hub/offline.html",
        "/online-tools-hub/assets/app.js",
      ],
    });

    expect(source).toContain('const BASE_PATH = "/online-tools-hub/"');
    expect(source).toContain('event.data?.type === "SKIP_WAITING"');
    expect(source).toContain('request.method !== "GET"');
    expect(source).toContain('cache: "reload"');
    expect(source).toContain("url.origin !== self.location.origin");
    expect(source).toContain('details.url.search === ""');
    expect(source).toContain("normalizedNavigationCacheKey");
    expect(source).toContain("name.startsWith(CACHE_PREFIX)");
    expect(source).toContain("respondToNavigation");
    expect(source).not.toContain("cache.put(");
    expect(source).not.toContain('addEventListener("sync"');
    expect(source).not.toContain('addEventListener("push"');
  });

  it("requires an offline fallback in the allowlist", () => {
    expect(() =>
      createServiceWorkerSource({
        basePath: "/online-tools-hub/",
        version: "test",
        urls: ["/online-tools-hub/"],
      }),
    ).toThrow("离线回退页未进入预缓存");
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

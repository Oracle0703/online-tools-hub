import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";

import { expect, test, type Page } from "@playwright/test";

type ClipboardProbe = {
  reads: number;
  readTexts: number;
  writes: number;
};

function canaryRepresentations(canary: string): string[] {
  const base64 = Buffer.from(canary, "utf8").toString("base64");

  return [
    canary,
    encodeURI(canary),
    encodeURIComponent(canary),
    base64,
    base64.replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, ""),
    createHash("sha256").update(canary).digest("hex"),
  ];
}

async function readPersistentSurfaces(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const serialize = (value: unknown): string => {
      try {
        return JSON.stringify(value) ?? "";
      } catch {
        return String(value);
      }
    };
    const indexedDbEntries: string[] = [];

    if (typeof indexedDB.databases === "function") {
      for (const databaseInfo of await indexedDB.databases()) {
        if (!databaseInfo.name) continue;
        const database = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open(databaseInfo.name!);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });

        for (const storeName of Array.from(database.objectStoreNames)) {
          const entry = await new Promise<{
            keys: IDBValidKey[];
            values: unknown[];
          }>((resolve, reject) => {
            const transaction = database.transaction(storeName, "readonly");
            const store = transaction.objectStore(storeName);
            const keysRequest = store.getAllKeys();
            const valuesRequest = store.getAll();
            transaction.oncomplete = () =>
              resolve({
                keys: keysRequest.result,
                values: valuesRequest.result,
              });
            transaction.onerror = () => reject(transaction.error);
            transaction.onabort = () => reject(transaction.error);
          });
          indexedDbEntries.push(
            serialize({
              database: databaseInfo.name,
              store: storeName,
              ...entry,
            }),
          );
        }
        database.close();
      }
    }

    const cacheEntries: unknown[] = [];
    for (const cacheName of await caches.keys()) {
      const cache = await caches.open(cacheName);
      for (const request of await cache.keys()) {
        const response = await cache.match(request);
        const body = await (async () => {
          try {
            return response ? await response.clone().text() : "";
          } catch {
            return "[unreadable response body]";
          }
        })();
        cacheEntries.push({
          cacheName,
          request: {
            method: request.method,
            url: request.url,
          },
          response: response
            ? { status: response.status, url: response.url, body }
            : null,
        });
      }
    }

    return serialize({
      url: location.href,
      historyState: serialize(history.state),
      localStorage: Object.entries(localStorage),
      sessionStorage: Object.entries(sessionStorage),
      cookie: document.cookie,
      indexedDB: indexedDbEntries,
      cacheStorage: cacheEntries,
    });
  });
}

function expectNoCanaryRepresentation(
  observable: string,
  representations: string[],
  surface: string,
): void {
  for (const representation of representations) {
    expect(
      observable,
      `${surface} 不应包含 canary 表示：${representation}`,
    ).not.toContain(representation);
  }
}

async function installClipboardProbe(
  page: Page,
  copiedValues: string[],
  options: { rejectWrites?: boolean } = {},
): Promise<void> {
  await page.exposeFunction("__captureRelayCopy", (value: string) => {
    copiedValues.push(value);
  });
  await page.addInitScript(({ rejectWrites }) => {
    const probe: ClipboardProbe = { reads: 0, readTexts: 0, writes: 0 };
    const clipboard = {
      read: async () => {
        probe.reads += 1;
        return [];
      },
      readText: async () => {
        probe.readTexts += 1;
        return "UNEXPECTED_CLIPBOARD_READ";
      },
      writeText: async (value: string) => {
        probe.writes += 1;
        if (rejectWrites) throw new Error("clipboard denied");
        await (
          globalThis as typeof globalThis & {
            __captureRelayCopy: (copied: string) => Promise<void>;
          }
        ).__captureRelayCopy(value);
      },
    };

    try {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: clipboard,
      });
    } catch {
      Object.defineProperty(Object.getPrototypeOf(navigator), "clipboard", {
        configurable: true,
        value: clipboard,
      });
    }
    Object.defineProperty(globalThis, "__relayClipboardProbe", {
      configurable: true,
      value: probe,
    });
  }, options);
}

async function clipboardProbe(page: Page): Promise<ClipboardProbe> {
  return page.evaluate(
    () =>
      (
        globalThis as typeof globalThis & {
          __relayClipboardProbe: ClipboardProbe;
        }
      ).__relayClipboardProbe,
  );
}

test("CSV → JSON 接力仅在点击后复制，目标页保持空白且不读取剪贴板", async ({
  page,
}) => {
  const copiedValues: string[] = [];
  const canary = "RELAY_PRIVATE_CANARY_中文🙂?&";
  const representations = canaryRepresentations(canary);
  await installClipboardProbe(page, copiedValues);
  await page.goto("./tools/csv-json-converter/", { waitUntil: "networkidle" });

  await page.getByLabel("CSV 输入").fill(`name,private\nAlice,${canary}`);
  await page.getByRole("button", { name: "转换为 JSON" }).click();

  const relay = page.getByRole("complementary", {
    name: "JSON 结果 → JSON 格式化",
  });
  await expect(relay).toContainText("点击后才会复制并打开");
  await expect(relay).toContainText("到达后请手动粘贴");
  await expect(relay).toContainText("不会自动读取剪贴板");
  expect(copiedValues).toEqual([]);
  expect(await clipboardProbe(page)).toEqual({
    reads: 0,
    readTexts: 0,
    writes: 0,
  });

  const initialStatus = relay.locator(".tool-relay__status");
  await expect(initialStatus).toBeAttached();
  await expect(initialStatus).toHaveText("等待接力操作。");
  await expect(initialStatus).not.toHaveAttribute("role");
  await expect(initialStatus).not.toHaveAttribute("aria-live");

  const navigationRequests: string[] = [];
  page.on("request", (request) => {
    if (!/^https?:/u.test(request.url())) return;
    navigationRequests.push(
      [request.method(), request.url(), request.postData() ?? ""].join(" "),
    );
  });

  await relay.getByRole("button", { name: "复制并打开 JSON 格式化" }).click();
  await expect(relay.getByRole("status")).toContainText(
    "已复制，正在打开目标工具",
    { timeout: 2_000 },
  );
  await page.waitForURL(/\/tools\/json-formatter\/$/u);
  await page.waitForLoadState("networkidle");

  expect(copiedValues).toHaveLength(1);
  expect(copiedValues[0]).toContain(canary);
  await expect(page.getByLabel("输入", { exact: true })).toHaveValue("");
  expect(await clipboardProbe(page)).toEqual({
    reads: 0,
    readTexts: 0,
    writes: 0,
  });

  const persistedSurface = await readPersistentSurfaces(page);
  expectNoCanaryRepresentation(
    persistedSurface,
    representations,
    "URL、history、存储、IndexedDB 或 Cache Storage",
  );
  expectNoCanaryRepresentation(
    navigationRequests.join("\n"),
    representations,
    "导航相关 HTTP URL 或请求体",
  );
});

test("Base64 解码为非 JSON 文本时不显示 JSON 接力", async ({ page }) => {
  await page.goto("./tools/base64-codec/", { waitUntil: "networkidle" });

  const operation = page.getByRole("group", { name: "操作" });
  await operation.getByText("解码", { exact: true }).click();
  await page.getByLabel("Base64 输入").fill("SGVsbG8=");
  await page.getByRole("button", { name: "解码 Base64" }).click();

  await expect(page.getByLabel("UTF-8 结果")).toHaveValue("Hello");
  await expect(
    page.getByRole("button", { name: "复制并打开 JSON 格式化" }),
  ).toHaveCount(0);
  await expect(page.locator('[data-tool-relay="json-formatter"]')).toHaveCount(
    0,
  );
});

test("CSV 生成的 JSON 超过目标输入上限时不提供接力", async ({ page }) => {
  await page.goto("./tools/csv-json-converter/", {
    waitUntil: "networkidle",
  });

  const headers = Array.from(
    { length: 120 },
    (_, index) => `column-${index}-${"x".repeat(64)}`,
  );
  const row = Array.from({ length: headers.length }, () => "v").join(",");
  const csv = [
    headers.join(","),
    ...Array.from({ length: 230 }, () => row),
  ].join("\n");

  await page.getByLabel("CSV 输入").fill(csv);
  await page.getByRole("button", { name: "转换为 JSON" }).click();
  const output = page.getByLabel("JSON 输出");
  await expect
    .poll(() =>
      output.evaluate(
        (element) =>
          new TextEncoder().encode((element as HTMLTextAreaElement).value)
            .byteLength,
      ),
    )
    .toBeGreaterThan(2 * 1024 * 1024);

  await expect(
    page.getByRole("button", { name: "复制并打开 JSON 格式化" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "交换输入输出" }),
  ).toBeDisabled();
});

test("剪贴板写入失败时停留原页并给出可访问错误", async ({ page }) => {
  const copiedValues: string[] = [];
  await installClipboardProbe(page, copiedValues, { rejectWrites: true });
  await page.goto("./tools/base64-codec/", { waitUntil: "networkidle" });

  const operation = page.getByRole("group", { name: "操作" });
  await operation.getByText("解码", { exact: true }).click();
  await page.getByLabel("Base64 输入").fill("eyJvayI6dHJ1ZX0=");
  await page.getByRole("button", { name: "解码 Base64" }).click();
  const originalUrl = page.url();

  await page.getByRole("button", { name: "复制并打开 JSON 格式化" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "复制失败，未打开目标工具",
  );
  expect(page.url()).toBe(originalUrl);
  expect(copiedValues).toEqual([]);
});

test("URL 与 JWT 都提供静态目标的显式接力", async ({ page }) => {
  const copiedValues: string[] = [];
  await installClipboardProbe(page, copiedValues);

  await page.goto("./tools/url-codec/", { waitUntil: "networkidle" });
  await page
    .getByLabel("输入")
    .fill("https%3A%2F%2Fexample.com%2Fsearch%3Fq%3Dlocal%26tag%3Done");
  await page.getByRole("button", { name: "URL 解码" }).click();
  await expect(
    page.getByRole("button", { name: "复制并打开 查询参数解析" }),
  ).toBeVisible();

  await page.goto("./tools/jwt-decoder/", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "载入示例" }).click();
  await page.getByRole("button", { name: "解析 JWT" }).click();
  const relayButton = page.getByRole("button", {
    name: "复制并打开 JSON 格式化",
  });
  await expect(relayButton).toBeVisible();

  await page.setViewportSize({ width: 360, height: 800 });
  const box = await relayButton.boundingBox();
  expect(box?.height).toBeGreaterThanOrEqual(44);
  const widths = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(widths.scroll).toBeLessThanOrEqual(widths.client + 1);
});

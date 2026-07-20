import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";

import { expect, test, type Page } from "@playwright/test";

type PrivacyProbe = {
  readCalls: number;
  readTextCalls: number;
  objectUrlCalls: number;
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

async function installPrivacyProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const probe: PrivacyProbe = {
      readCalls: 0,
      readTextCalls: 0,
      objectUrlCalls: 0,
    };
    const clipboard = {
      read: async () => {
        probe.readCalls += 1;
        return [];
      },
      readText: async () => {
        probe.readTextCalls += 1;
        return "UNEXPECTED_CLIPBOARD_READ";
      },
      write: async () => undefined,
      writeText: async () => undefined,
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

    const nativeCreateObjectUrl = URL.createObjectURL.bind(URL);
    const createObjectUrl = (object: Blob | MediaSource) => {
      probe.objectUrlCalls += 1;
      return nativeCreateObjectUrl(object);
    };
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      writable: true,
      value: createObjectUrl,
    });

    Object.defineProperty(globalThis, "__smartInputPrivacyProbe", {
      configurable: true,
      value: probe,
    });
  });
}

async function waitForSmartInput(page: Page) {
  const island = page.locator(
    'astro-island[component-url*="SmartInputDetector"]',
  );
  await expect(island).toHaveCount(1);
  await expect.poll(() => island.getAttribute("ssr")).toBeNull();
  return page.getByRole("region", {
    name: "粘贴内容，找到合适的工具",
  });
}

async function readPrivacyProbe(page: Page): Promise<PrivacyProbe> {
  return page.evaluate(
    () =>
      (
        globalThis as typeof globalThis & {
          __smartInputPrivacyProbe: PrivacyProbe;
        }
      ).__smartInputPrivacyProbe,
  );
}

test.describe("首页智能入口", () => {
  test("识别 JSON 并给出不超过三个带理由的工具建议", async ({ page }) => {
    await page.goto("./", { waitUntil: "networkidle" });
    const smartInput = await waitForSmartInput(page);

    await smartInput
      .getByLabel("粘贴或输入文本")
      .fill('[{"name":"A"},{"name":"B"}]');

    await expect(
      smartInput.getByRole("heading", { name: "JSON 数据" }),
    ).toBeVisible();
    await expect(smartInput.getByRole("status")).toContainText(
      "没有修改或保存内容",
    );
    const recommendations = smartInput.locator(
      ".smart-input__recommendations li",
    );
    await expect(recommendations).toHaveCount(3);
    await expect(recommendations.first()).toContainText("JSON 格式化");
    await expect(recommendations.first()).toContainText("检查 JSON 语法");
    await expect(smartInput).toContainText(
      "内容不会被自动带入；请在工具内再次粘贴",
    );

    for (const link of await recommendations.getByRole("link").all()) {
      const href = await link.getAttribute("href");
      expect(href).toMatch(/\/tools\/[a-z0-9-]+\/$/u);
      expect(href).not.toContain("?");
      expect(href).not.toContain("#");
    }
  });

  test("主动输入不读取剪贴板、不请求、不持久化且推荐链接不传递原文", async ({
    page,
  }) => {
    const canary = "OTH_SMART_PRIVATE_中文🙂?&";
    const representations = canaryRepresentations(canary);
    await installPrivacyProbe(page);
    await page.goto("./", { waitUntil: "networkidle" });
    const smartInput = await waitForSmartInput(page);
    const initialUrl = page.url();
    const requestsAfterInput: string[] = [];

    page.on("request", (request) => {
      if (/^https?:/u.test(request.url())) {
        requestsAfterInput.push(
          `${request.method()} ${request.url()} ${request.postData() ?? ""}`,
        );
      }
    });

    await smartInput
      .getByLabel("粘贴或输入文本")
      .fill(JSON.stringify({ private: canary, ready: true }));
    await expect(
      smartInput.getByRole("heading", { name: "JSON 数据" }),
    ).toBeVisible();

    expect(await readPrivacyProbe(page)).toEqual({
      readCalls: 0,
      readTextCalls: 0,
      objectUrlCalls: 0,
    });
    expect(requestsAfterInput).toEqual([]);
    expect(page.url()).toBe(initialUrl);

    const persistedBeforeNavigation = await readPersistentSurfaces(page);
    expectNoCanaryRepresentation(
      persistedBeforeNavigation,
      representations,
      "URL、history、存储、IndexedDB 或 Cache Storage",
    );

    await smartInput.getByRole("link", { name: /JSON 格式化/u }).click();
    await expect(page).toHaveURL(/\/tools\/json-formatter\/$/u);
    await page.waitForLoadState("networkidle");
    const destinationUrl = new URL(page.url());
    expect(destinationUrl.search).toBe("");
    expect(destinationUrl.hash).toBe("");
    await expect(page.getByLabel("输入", { exact: true })).toHaveValue("");
    expect(await readPrivacyProbe(page)).toMatchObject({
      readCalls: 0,
      readTextCalls: 0,
    });

    const persistedAfterNavigation = await readPersistentSurfaces(page);
    expectNoCanaryRepresentation(
      persistedAfterNavigation,
      representations,
      "导航后的 URL、history、存储、IndexedDB 或 Cache Storage",
    );
    expectNoCanaryRepresentation(
      requestsAfterInput.join("\n"),
      representations,
      "输入与导航后的 HTTP URL 或请求体",
    );
  });

  test("图片只依据小段签名字节识别且不创建预览地址", async ({ page }) => {
    await installPrivacyProbe(page);
    await page.goto("./", { waitUntil: "networkidle" });
    const smartInput = await waitForSmartInput(page);
    const pngSignature = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
    ]);

    await smartInput.getByLabel("选择图片").setInputFiles({
      name: "local-only.png",
      mimeType: "image/png",
      buffer: pngSignature,
    });

    await expect(
      smartInput.getByRole("heading", { name: "PNG 图片" }),
    ).toBeVisible();
    await expect(smartInput.getByRole("status")).toContainText(
      "签名字节确认格式",
    );
    await expect(
      smartInput.getByRole("link", { name: /图片压缩/u }),
    ).toBeVisible();
    expect(await readPrivacyProbe(page)).toEqual({
      readCalls: 0,
      readTextCalls: 0,
      objectUrlCalls: 0,
    });
  });

  test("键盘可以输入、查看判断并到达推荐工具", async ({ page }) => {
    await page.goto("./", { waitUntil: "networkidle" });
    const smartInput = await waitForSmartInput(page);
    const input = smartInput.getByLabel("粘贴或输入文本");

    await input.focus();
    await page.keyboard.type("1710000000");
    await expect(
      smartInput.getByRole("heading", { name: "Unix 秒级时间戳" }),
    ).toBeVisible();

    await page.keyboard.press("Tab");
    await expect(smartInput.locator('input[type="file"]')).toBeFocused();
    await expect(
      smartInput.locator(".smart-input__dropzone label:focus-within"),
    ).toBeVisible();
    await page.keyboard.press("Tab");
    await expect(
      smartInput.getByRole("button", { name: "清空" }),
    ).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(
      smartInput.getByRole("link", { name: /时间戳转换/u }),
    ).toBeFocused();

    await smartInput.getByRole("button", { name: "清空" }).focus();
    await page.keyboard.press("Enter");
    await expect(input).toHaveValue("");
    await expect(input).toBeFocused();
  });
});

test.describe("首页智能入口移动端", () => {
  test.use({ viewport: { width: 360, height: 800 } });

  test("窄屏没有横向溢出并保留足够大的交互目标", async ({ page }) => {
    await page.goto("./", { waitUntil: "networkidle" });
    const smartInput = await waitForSmartInput(page);

    await smartInput
      .getByLabel("粘贴或输入文本")
      .fill("https://example.com/?q=hello&tag=a&tag=b");
    await expect(
      smartInput.getByRole("heading", { name: "带查询参数的完整 URL" }),
    ).toBeVisible();

    const layout = await page.evaluate(() => {
      const root = document.documentElement;
      const textarea = document.querySelector<HTMLTextAreaElement>(
        "[data-smart-input-text]",
      );
      const links = [
        ...document.querySelectorAll<HTMLAnchorElement>(
          ".smart-input__recommendations a",
        ),
      ];

      return {
        scrollWidth: root.scrollWidth,
        clientWidth: root.clientWidth,
        textareaWidth: textarea?.getBoundingClientRect().width ?? 0,
        recommendationHeights: links.map(
          (link) => link.getBoundingClientRect().height,
        ),
      };
    });

    expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth + 1);
    expect(layout.textareaWidth).toBeLessThanOrEqual(layout.clientWidth);
    expect(layout.recommendationHeights.length).toBe(2);
    expect(layout.recommendationHeights.every((height) => height >= 44)).toBe(
      true,
    );
    await expect(smartInput.getByLabel("选择图片")).toBeAttached();
  });
});

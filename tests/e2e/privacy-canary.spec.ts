import { createHash, randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";

import { expect, test, type Page } from "@playwright/test";

type ClipboardReadProbe = {
  installed: boolean;
  readCalls: number;
  readTextCalls: number;
};

type BlobUrlProbe = {
  installed: boolean;
  created: string[];
  revoked: string[];
  active: Set<string>;
};

const canaryRoutes = (
  process.env.PRIVACY_CANARY_ROUTES ??
  process.env.PRIVACY_CANARY_ROUTE ??
  ""
)
  .split(",")
  .map((route) => route.trim())
  .filter(Boolean);
const inputSelector =
  process.env.PRIVACY_CANARY_INPUT ?? "[data-privacy-canary-input]";
const actionSelector =
  process.env.PRIVACY_CANARY_ACTION ?? "[data-privacy-canary-action]";

function asBaseRelativeRoute(route: string): string {
  if (/^https?:\/\//u.test(route)) {
    return route;
  }

  const path = route.replace(/^\/+|\/+$/gu, "");
  return path ? `./${path}/` : "./";
}

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

async function installClipboardReadProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const probe: ClipboardReadProbe = {
      installed: false,
      readCalls: 0,
      readTextCalls: 0,
    };
    const clipboard = {
      read: async () => {
        probe.readCalls += 1;
        return [];
      },
      readText: async () => {
        probe.readTextCalls += 1;
        return "UNEXPECTED_AUTOMATIC_CLIPBOARD_READ";
      },
      write: async () => undefined,
      writeText: async () => undefined,
    };
    const clipboardDescriptor: PropertyDescriptor = {
      configurable: true,
      get: () => clipboard,
    };

    try {
      Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
    } catch {
      Object.defineProperty(
        Object.getPrototypeOf(navigator),
        "clipboard",
        clipboardDescriptor,
      );
    }

    probe.installed = Object.is(navigator.clipboard, clipboard);
    Object.defineProperty(globalThis, "__privacyClipboardReadProbe", {
      configurable: true,
      value: probe,
    });
  });
}

async function expectNoClipboardReads(page: Page): Promise<void> {
  const probe = await page.evaluate(() => {
    const state = (
      globalThis as typeof globalThis & {
        __privacyClipboardReadProbe?: ClipboardReadProbe;
      }
    ).__privacyClipboardReadProbe;

    return state ? { ...state } : null;
  });

  if (!probe) throw new Error("剪贴板读取探针未注入页面");
  expect(probe.installed, "剪贴板读取探针必须成功替换 Clipboard API").toBe(
    true,
  );
  expect(
    { read: probe.readCalls, readText: probe.readTextCalls },
    "页面加载和工具操作均不得调用 clipboard.read/readText",
  ).toEqual({ read: 0, readText: 0 });
}

async function installBlobUrlProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const nativeCreateObjectUrl = URL.createObjectURL.bind(URL);
    const nativeRevokeObjectUrl = URL.revokeObjectURL.bind(URL);
    const probe: BlobUrlProbe = {
      installed: false,
      created: [],
      revoked: [],
      active: new Set<string>(),
    };
    const createObjectUrl = (object: Blob | MediaSource): string => {
      const url = nativeCreateObjectUrl(object);
      probe.created.push(url);
      probe.active.add(url);
      return url;
    };
    const revokeObjectUrl = (url: string): void => {
      probe.revoked.push(url);
      probe.active.delete(url);
      nativeRevokeObjectUrl(url);
    };

    Object.defineProperties(URL, {
      createObjectURL: {
        configurable: true,
        writable: true,
        value: createObjectUrl,
      },
      revokeObjectURL: {
        configurable: true,
        writable: true,
        value: revokeObjectUrl,
      },
    });
    probe.installed =
      URL.createObjectURL === createObjectUrl &&
      URL.revokeObjectURL === revokeObjectUrl;
    Object.defineProperty(globalThis, "__privacyBlobUrlProbe", {
      configurable: true,
      value: probe,
    });
  });
}

async function readBlobUrlProbe(page: Page): Promise<{
  installed: boolean;
  created: string[];
  revoked: string[];
  active: string[];
}> {
  const probe = await page.evaluate(() => {
    const state = (
      globalThis as typeof globalThis & {
        __privacyBlobUrlProbe?: BlobUrlProbe;
      }
    ).__privacyBlobUrlProbe;

    return state
      ? {
          installed: state.installed,
          created: [...state.created],
          revoked: [...state.revoked],
          active: [...state.active],
        }
      : null;
  });

  if (!probe) throw new Error("Blob URL 生命周期探针未注入页面");
  expect(probe.installed, "Blob URL 生命周期探针必须成功包装 URL API").toBe(
    true,
  );
  return probe;
}

test.describe("隐私 canary 契约", () => {
  test.skip(
    canaryRoutes.length === 0,
    "工具页接入 canary data 属性后，设置 PRIVACY_CANARY_ROUTES 即可启用",
  );

  for (const canaryRoute of canaryRoutes) {
    test(`${canaryRoute} 操作不会产生请求、持久化、记录输入或读取剪贴板`, async ({
      page,
    }) => {
      const canary = `OTH_CANARY_${randomUUID()}_中文🙂?&`;
      const representations = canaryRepresentations(canary);
      const consoleEntries: string[] = [];

      await installClipboardReadProbe(page);
      page.on("console", (message) => consoleEntries.push(message.text()));
      page.on("pageerror", (error) => consoleEntries.push(error.message));

      await page.goto(asBaseRelativeRoute(canaryRoute), {
        waitUntil: "networkidle",
      });

      const requestsAfterInput: string[] = [];
      page.on("request", (request) => {
        requestsAfterInput.push(
          [request.method(), request.url(), request.postData() ?? ""].join(" "),
        );
      });

      const input = page.locator(inputSelector).first();
      const action = page.locator(actionSelector).first();

      await expect(input, "canary 输入控件不存在").toBeVisible();
      await expect(action, "canary 执行控件不存在").toBeVisible();
      await input.fill(canary);
      await action.click();
      await page.waitForTimeout(300);

      await expectNoClipboardReads(page);
      expect(requestsAfterInput, "输入 canary 后不应产生任何网络请求").toEqual(
        [],
      );

      const browserState = await page.evaluate(async () => {
        const serialize = (value: unknown): string => {
          try {
            return JSON.stringify(value) ?? "";
          } catch {
            return String(value);
          }
        };

        const localStorageValues = Object.entries(localStorage);
        const sessionStorageValues = Object.entries(sessionStorage);
        const indexedDbValues: unknown[] = [];

        if (typeof indexedDB.databases === "function") {
          const databases = await indexedDB.databases();

          for (const databaseInfo of databases) {
            if (!databaseInfo.name) continue;

            const database = await new Promise<IDBDatabase>(
              (resolve, reject) => {
                const request = indexedDB.open(databaseInfo.name!);
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
              },
            );

            for (const storeName of Array.from(database.objectStoreNames)) {
              const values = await new Promise<unknown[]>((resolve, reject) => {
                const transaction = database.transaction(storeName, "readonly");
                const request = transaction.objectStore(storeName).getAll();
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
              });

              indexedDbValues.push({
                database: databaseInfo.name,
                store: storeName,
                values,
              });
            }

            database.close();
          }
        }

        return {
          url: location.href,
          historyState: serialize(history.state),
          cookie: document.cookie,
          localStorage: serialize(localStorageValues),
          sessionStorage: serialize(sessionStorageValues),
          indexedDB: serialize(indexedDbValues),
        };
      });

      const observableState = JSON.stringify({ browserState, consoleEntries });

      for (const representation of representations) {
        expect(
          observableState,
          `浏览器状态或日志中不应出现 canary 表示：${representation}`,
        ).not.toContain(representation);
      }

      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(
        page.locator(inputSelector).first(),
        "刷新后不应恢复上一次输入",
      ).not.toHaveValue(canary);
      await expectNoClipboardReads(page);
    });
  }
});

test.describe("UUID 本地生成隐私契约", () => {
  test("生成结果不产生请求、不持久化、不读取剪贴板且刷新后清除", async ({
    page,
  }) => {
    await installClipboardReadProbe(page);
    await page.goto("./tools/uuid-generator/", { waitUntil: "networkidle" });
    const initialUrl = page.url();
    const requestsAfterAction: string[] = [];

    page.on("request", (request) => {
      requestsAfterAction.push(`${request.method()} ${request.url()}`);
    });

    await page.getByLabel("生成数量").fill("10");
    await page.getByRole("button", { name: "生成 UUID" }).click();
    await expect(page.locator(".uuid-tool__list li")).toHaveCount(10);
    await page.waitForTimeout(200);

    await expectNoClipboardReads(page);
    expect(requestsAfterAction).toEqual([]);
    expect(page.url()).toBe(initialUrl);
    expect(
      await page.evaluate(async () => ({
        cookie: document.cookie,
        localStorage: Object.entries(localStorage),
        sessionStorage: Object.entries(sessionStorage),
        indexedDatabases:
          typeof indexedDB.databases === "function"
            ? await indexedDB.databases()
            : [],
      })),
    ).toEqual({
      cookie: "",
      localStorage: [],
      sessionStorage: [],
      indexedDatabases: [],
    });

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator(".uuid-tool__list li")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "等待生成" })).toBeVisible();
    await expectNoClipboardReads(page);
  });
});

test.describe("图片压缩本地处理隐私契约", () => {
  const pngFixture = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAYAAAC09K7GAAAANUlEQVR4nBXIMREAMAgEwVdHHRF4SYMXbHxNg5zLZMuVxAktpWZ0kRIil8pm8ochvJSb8eUBpjAeBjxGdD0AAAAASUVORK5CYII=",
    "base64",
  );

  test("文件名与图片数据不产生请求、不持久化、不读取剪贴板且刷新后清除", async ({
    page,
  }) => {
    const canary = `OTH_IMAGE_CANARY_${randomUUID()}_中文🙂`;
    const representations = canaryRepresentations(canary);
    const consoleEntries: string[] = [];

    await installClipboardReadProbe(page);
    page.on("console", (message) => consoleEntries.push(message.text()));
    page.on("pageerror", (error) => consoleEntries.push(error.message));
    await page.goto("./tools/image-compressor/", { waitUntil: "networkidle" });
    const initialUrl = page.url();

    const requestsAfterInput: string[] = [];
    page.on("request", (request) => {
      if (!/^https?:/u.test(request.url())) return;

      requestsAfterInput.push(
        [request.method(), request.url(), request.postData() ?? ""].join(" "),
      );
    });

    await page.getByLabel("选择 JPEG、PNG 或 WebP 图片").setInputFiles({
      name: `${canary}.png`,
      mimeType: "image/png",
      buffer: pngFixture,
    });
    await expect(
      page.getByRole("list", { name: "图片处理结果" }).getByRole("listitem"),
    ).toContainText(canary);
    await page.locator("[data-privacy-canary-action]").click();
    await expect(
      page.locator(".image-compressor-tool__feedback"),
    ).toContainText("已完成 1 张图片", { timeout: 30_000 });
    await page.waitForTimeout(300);

    await expectNoClipboardReads(page);
    expect(
      requestsAfterInput,
      "选择与处理图片后不应产生任何 HTTP(S) 网络请求",
    ).toEqual([]);
    expect(page.url(), "文件名不应写入 URL 或 history").toBe(initialUrl);

    const browserState = await page.evaluate(async () => {
      const serialize = (value: unknown): string => {
        try {
          return JSON.stringify(value) ?? "";
        } catch {
          return String(value);
        }
      };
      const indexedDbValues: unknown[] = [];

      if (typeof indexedDB.databases === "function") {
        const databases = await indexedDB.databases();
        for (const databaseInfo of databases) {
          if (!databaseInfo.name) continue;
          const database = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open(databaseInfo.name!);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          for (const storeName of Array.from(database.objectStoreNames)) {
            const values = await new Promise<unknown[]>((resolve, reject) => {
              const transaction = database.transaction(storeName, "readonly");
              const request = transaction.objectStore(storeName).getAll();
              request.onsuccess = () => resolve(request.result);
              request.onerror = () => reject(request.error);
            });
            indexedDbValues.push({
              database: databaseInfo.name,
              store: storeName,
              values,
            });
          }
          database.close();
        }
      }

      return {
        url: location.href,
        historyState: serialize(history.state),
        cookie: document.cookie,
        localStorage: serialize(Object.entries(localStorage)),
        sessionStorage: serialize(Object.entries(sessionStorage)),
        indexedDB: serialize(indexedDbValues),
      };
    });
    const observableState = JSON.stringify({ browserState, consoleEntries });

    for (const representation of representations) {
      expect(
        observableState,
        `浏览器状态或日志中不应出现图片 canary 表示：${representation}`,
      ).not.toContain(representation);
    }

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("list", { name: "图片处理结果" }),
      "刷新后不应恢复图片处理列表",
    ).toHaveCount(0);
    await expect(page.locator("[data-privacy-canary-action]")).toBeDisabled();
    await expectNoClipboardReads(page);
  });

  test("删除和清空图片会撤销相关的全部 Blob URL", async ({ page }) => {
    await installBlobUrlProbe(page);
    await page.goto("./tools/image-compressor/", { waitUntil: "networkidle" });

    await page.getByLabel("选择 JPEG、PNG 或 WebP 图片").setInputFiles([
      {
        name: "blob-delete.png",
        mimeType: "image/png",
        buffer: pngFixture,
      },
      {
        name: "blob-clear.png",
        mimeType: "image/png",
        buffer: pngFixture,
      },
    ]);

    const items = page
      .getByRole("list", { name: "图片处理结果" })
      .getByRole("listitem");
    await expect(items).toHaveCount(2);
    const deleteItem = items.filter({ hasText: "blob-delete.png" });
    const clearItem = items.filter({ hasText: "blob-clear.png" });
    const deleteSourceUrl = await deleteItem.locator("img").getAttribute("src");
    const clearSourceUrl = await clearItem.locator("img").getAttribute("src");
    expect(deleteSourceUrl).toMatch(/^blob:/u);
    expect(clearSourceUrl).toMatch(/^blob:/u);

    await page.locator("[data-privacy-canary-action]").click();
    await expect(
      page.locator(".image-compressor-tool__feedback"),
    ).toContainText("已完成 2 张图片", { timeout: 30_000 });
    await expect(deleteItem.locator("img")).not.toHaveAttribute(
      "src",
      deleteSourceUrl!,
    );
    await expect(clearItem.locator("img")).not.toHaveAttribute(
      "src",
      clearSourceUrl!,
    );
    const deleteResultUrl = await deleteItem.locator("img").getAttribute("src");
    const clearResultUrl = await clearItem.locator("img").getAttribute("src");
    expect(deleteResultUrl).toMatch(/^blob:/u);
    expect(clearResultUrl).toMatch(/^blob:/u);

    const afterCompression = await readBlobUrlProbe(page);
    expect(afterCompression.active).toEqual(
      expect.arrayContaining([
        deleteSourceUrl!,
        deleteResultUrl!,
        clearSourceUrl!,
        clearResultUrl!,
      ]),
    );

    await page.getByRole("button", { name: "移除 blob-delete.png" }).click();
    await expect(items).toHaveCount(1);
    await expect
      .poll(async () => {
        const { active } = await readBlobUrlProbe(page);
        return [deleteSourceUrl!, deleteResultUrl!].filter((url) =>
          active.includes(url),
        );
      })
      .toEqual([]);
    const afterDelete = await readBlobUrlProbe(page);
    expect(afterDelete.revoked).toEqual(
      expect.arrayContaining([deleteSourceUrl!, deleteResultUrl!]),
    );
    expect(afterDelete.active).toEqual(
      expect.arrayContaining([clearSourceUrl!, clearResultUrl!]),
    );

    await page.getByRole("button", { name: "清空", exact: true }).click();
    await expect(items).toHaveCount(0);
    await expect
      .poll(async () => (await readBlobUrlProbe(page)).active)
      .toEqual([]);
    const afterClear = await readBlobUrlProbe(page);
    expect(afterClear.created.length).toBeGreaterThanOrEqual(4);
    expect(afterClear.revoked).toEqual(
      expect.arrayContaining(afterClear.created),
    );
  });
});

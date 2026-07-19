import { createHash, randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";

import { expect, test } from "@playwright/test";

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

test.describe("隐私 canary 契约", () => {
  test.skip(
    canaryRoutes.length === 0,
    "工具页接入 canary data 属性后，设置 PRIVACY_CANARY_ROUTES 即可启用",
  );

  for (const canaryRoute of canaryRoutes) {
    test(`${canaryRoute} 操作不会产生请求、持久化或记录输入`, async ({
      page,
    }) => {
      const canary = `OTH_CANARY_${randomUUID()}_中文🙂?&`;
      const representations = canaryRepresentations(canary);
      const consoleEntries: string[] = [];

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
    });
  }
});

test.describe("UUID 本地生成隐私契约", () => {
  test("生成结果不产生请求、不持久化且刷新后清除", async ({ page }) => {
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
  });
});

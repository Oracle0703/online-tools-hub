import { createHash, randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";

import { expect, test } from "@playwright/test";

const canaryRoute = process.env.PRIVACY_CANARY_ROUTE;
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
    !canaryRoute,
    "工具页接入 canary data 属性后，设置 PRIVACY_CANARY_ROUTE 即可启用",
  );

  test("工具操作不会产生请求，也不会持久化或记录输入", async ({ page }) => {
    const canary = `OTH_CANARY_${randomUUID()}_中文🙂?&`;
    const representations = canaryRepresentations(canary);
    const consoleEntries: string[] = [];

    page.on("console", (message) => consoleEntries.push(message.text()));
    page.on("pageerror", (error) => consoleEntries.push(error.message));

    await page.goto(asBaseRelativeRoute(canaryRoute!), {
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
});

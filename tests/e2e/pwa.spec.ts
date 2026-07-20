import { expect, test } from "@playwright/test";

test("PWA 清单和图标均使用 GitHub Pages 子路径", async ({ page, request }) => {
  await page.goto("./", { waitUntil: "domcontentloaded" });

  const manifestHref = await page
    .locator('link[rel="manifest"]')
    .getAttribute("href");
  expect(manifestHref).toBe("/online-tools-hub/manifest.webmanifest");

  const manifestResponse = await request.get(manifestHref!);
  expect(manifestResponse.ok()).toBe(true);
  const manifest = (await manifestResponse.json()) as {
    id: string;
    scope: string;
    start_url: string;
    display_override: string[];
    icons: Array<{ src: string; sizes: string; purpose: string }>;
  };
  expect(manifest.id).toBe("/online-tools-hub/");
  expect(manifest.scope).toBe("/online-tools-hub/");
  expect(manifest.start_url).toBe("/online-tools-hub/");
  expect(manifest.display_override).toEqual(["standalone", "minimal-ui"]);
  expect(manifest.icons).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ sizes: "192x192", purpose: "any" }),
      expect.objectContaining({ sizes: "512x512", purpose: "any" }),
      expect.objectContaining({ sizes: "512x512", purpose: "maskable" }),
    ]),
  );

  for (const icon of manifest.icons) {
    const response = await request.get(icon.src);
    expect(response.ok()).toBe(true);
    expect(response.headers()["content-type"]).toContain("image/png");
  }
});

test("安装按钮只在浏览器提供安装事件后出现", async ({ page }) => {
  await page.addInitScript(() => {
    const blockNativePrompt = (event: Event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    window.addEventListener("beforeinstallprompt", blockNativePrompt, true);
    Reflect.set(window, "__removePwaPromptBlocker", () => {
      window.removeEventListener(
        "beforeinstallprompt",
        blockNativePrompt,
        true,
      );
    });
  });
  await page.goto("./", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("button", { name: "安装应用" })).toHaveCount(0);

  await page.evaluate(() => {
    const removeBlocker = Reflect.get(window, "__removePwaPromptBlocker");
    if (typeof removeBlocker === "function") removeBlocker();
    Reflect.set(window, "__pwaPromptCalls", 0);
  });

  const installButton = page.getByRole("button", { name: "安装应用" });
  await expect
    .poll(async () => {
      await page.evaluate(() => {
        const event = new Event("beforeinstallprompt", { cancelable: true });
        Object.defineProperties(event, {
          prompt: {
            value: () => {
              const calls = Number(Reflect.get(window, "__pwaPromptCalls"));
              Reflect.set(window, "__pwaPromptCalls", calls + 1);
              return Promise.resolve();
            },
          },
          userChoice: {
            value: Promise.resolve({ outcome: "dismissed", platform: "test" }),
          },
        });
        window.dispatchEvent(event);
      });
      return installButton.count();
    })
    .toBe(1);
  await expect(installButton).toBeVisible();
  await installButton.click();
  await expect(installButton).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, "__pwaPromptCalls")))
    .toBe(1);
});

test("安装提示可暂时关闭且移动触控目标不小于 44px", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto("./", { waitUntil: "domcontentloaded" });

  const installButton = page.getByRole("button", { name: "安装应用" });
  const dismissButton = page.getByRole("button", { name: "暂不安装" });
  await expect
    .poll(async () => {
      await page.evaluate(() => {
        const event = new Event("beforeinstallprompt", { cancelable: true });
        Object.defineProperties(event, {
          prompt: { value: () => Promise.resolve() },
          userChoice: {
            value: Promise.resolve({ outcome: "dismissed", platform: "test" }),
          },
        });
        window.dispatchEvent(event);
      });
      return installButton.count();
    })
    .toBe(1);
  await expect(installButton).toBeVisible();
  await expect(dismissButton).toBeVisible();
  expect((await installButton.boundingBox())?.height).toBeGreaterThanOrEqual(
    44,
  );
  expect((await dismissButton.boundingBox())?.height).toBeGreaterThanOrEqual(
    44,
  );

  await dismissButton.click();
  await expect(page.locator('[data-pwa-notice="install"]')).toHaveCount(0);
});

test("预缓存页面可离线访问，未知地址使用离线回退", async ({
  browserName,
  context,
  page,
}) => {
  test.skip(
    browserName !== "chromium",
    "离线 Service Worker 门禁在 Chromium 执行",
  );

  await page.goto("./", { waitUntil: "networkidle" });
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload({ waitUntil: "networkidle" });
  await expect
    .poll(() =>
      page.evaluate(() => Boolean(navigator.serviceWorker.controller)),
    )
    .toBe(true);

  await page.goto("./tools/json-formatter/", { waitUntil: "networkidle" });
  await context.setOffline(true);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "JSON 格式化与校验",
      exact: true,
    }),
  ).toBeVisible();

  await page.goto("./not-cached/private-route/?input=never-cache", {
    waitUntil: "domcontentloaded",
  });
  await expect(
    page.getByRole("heading", { name: "网络暂时不可用" }),
  ).toBeVisible();
});

test("缓存不记录用户输入、查询参数、Blob 或 POST", async ({
  browserName,
  page,
}) => {
  test.skip(
    browserName !== "chromium",
    "Cache Storage 隐私门禁在 Chromium 执行",
  );

  await page.goto("./tools/json-formatter/", { waitUntil: "networkidle" });
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload({ waitUntil: "networkidle" });

  const sentinel = "PRIVATE_VALUE_MUST_NEVER_ENTER_PWA_CACHE_42";
  await page
    .getByLabel("输入", { exact: true })
    .fill(`{"secret":"${sentinel}"}`);
  const result = await page.evaluate(async (privateValue) => {
    const blobUrl = URL.createObjectURL(
      new Blob([privateValue], { type: "text/plain" }),
    );
    await fetch(blobUrl).catch(() => undefined);
    URL.revokeObjectURL(blobUrl);

    await fetch(`${window.location.pathname}?secret=${privateValue}`, {
      method: "POST",
      body: privateValue,
    }).catch(() => undefined);

    const cacheNames = (await caches.keys()).filter((name) =>
      name.startsWith("online-tools-hub-static-"),
    );
    const requests = (
      await Promise.all(
        cacheNames.map(async (name) => (await caches.open(name)).keys()),
      )
    ).flat();
    const responseBodies = await Promise.all(
      requests.map(async (request) => {
        const response = await caches.match(request);
        return response?.text().catch(() => "") ?? "";
      }),
    );

    return {
      cacheNames,
      urls: requests.map((request) => request.url),
      expectedPrefix: new URL("/online-tools-hub/", window.location.href).href,
      containsPrivateValue: responseBodies.some((body) =>
        body.includes(privateValue),
      ),
    };
  }, sentinel);

  expect(result.cacheNames).toHaveLength(1);
  expect(result.urls.length).toBeGreaterThan(0);
  expect(result.urls.every((value) => new URL(value).search === "")).toBe(true);
  expect(
    result.urls.every((value) => value.startsWith(result.expectedPrefix)),
  ).toBe(true);
  expect(result.urls.some((value) => value.includes(sentinel))).toBe(false);
  expect(result.containsPrivateValue).toBe(false);
});

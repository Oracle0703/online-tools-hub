import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

type MockPwaOptions = {
  initialState?: "shell" | "partial" | "complete";
  startBehavior?: "complete" | "cancel" | "cancel-complete" | "fail-once";
  statusBehavior?: "complete" | "fail-once";
  waitingUpdate?: boolean;
};

async function waitForServiceWorkerControl(page: Page) {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload({ waitUntil: "networkidle" });
  await expect
    .poll(() =>
      page.evaluate(() => Boolean(navigator.serviceWorker.controller)),
    )
    .toBe(true);
  await expect(page.locator("[data-pwa-offline-center]")).toHaveAttribute(
    "data-pwa-client-ready",
    "true",
  );
}

async function openOfflineCenter(page: Page) {
  const trigger = page
    .locator("[data-pwa-offline-trigger]")
    .filter({ hasText: "离线使用" })
    .first();
  await trigger.click();
  const dialog = page.locator("[data-pwa-offline-center]");
  await expect(dialog).toBeVisible();
  return { dialog, trigger };
}

async function downloadCompleteOfflinePackage(page: Page) {
  const { dialog } = await openOfflineCenter(page);
  const download = dialog.getByRole("button", {
    name: /下载完整离线包|继续下载完整离线包|重新下载/u,
  });
  await expect(download).toBeEnabled();
  await download.click();
  await expect(
    dialog.getByRole("heading", { name: "完整离线包已就绪" }),
  ).toBeVisible({ timeout: 90_000 });
  await dialog.getByRole("button", { name: "关闭面板" }).click();
}

async function installMockPwaWorker(page: Page, options: MockPwaOptions = {}) {
  await page.addInitScript((configuration: MockPwaOptions) => {
    const container = navigator.serviceWorker;
    if (!container) return;

    type RequestMessage = {
      type: string;
      protocol?: number;
      requestId?: string;
    };
    type PackageState = "shell" | "partial" | "complete";
    const messages: RequestMessage[] = [];
    let state: PackageState = configuration.initialState ?? "shell";
    let startCount = 0;
    let statusCount = 0;
    let startPort: MessagePort | null = null;
    let activeRequestId = "";
    const totalEntries = 5;
    const totalBytes = 5 * 1024 * 1024;

    const status = (type: string, requestId: string) => {
      const cachedEntries =
        state === "complete" ? totalEntries : state === "partial" ? 2 : 0;
      const cachedBytes =
        state === "complete"
          ? totalBytes
          : state === "partial"
            ? 2 * 1024 * 1024
            : 0;
      return {
        type,
        protocol: 1,
        requestId,
        buildVersion: "0123456789abcdef",
        state,
        cachedEntries,
        cachedBytes,
        missingEntries: totalEntries - cachedEntries,
        missingBytes: totalBytes - cachedBytes,
        totalEntries,
        totalBytes,
      };
    };

    const activeWorker = {
      state: "activated",
      postMessage(message: RequestMessage, transfer?: Transferable[]) {
        messages.push({ ...message });
        const port = transfer?.[0];
        if (!(port instanceof MessagePort) || !message.requestId) return;

        if (message.type === "PWA_OFFLINE_STATUS") {
          statusCount += 1;
          if (
            configuration.statusBehavior === "fail-once" &&
            statusCount === 1
          ) {
            port.postMessage({
              type: "PWA_OFFLINE_ERROR",
              protocol: 1,
              requestId: message.requestId,
              buildVersion: "0123456789abcdef",
              code: "network",
              retryable: true,
            });
            return;
          }
          port.postMessage(status("PWA_OFFLINE_STATUS", message.requestId));
          return;
        }
        if (message.type === "PWA_OFFLINE_PACKAGE_REMOVE") {
          state = "shell";
          port.postMessage(status("PWA_OFFLINE_REMOVED", message.requestId));
          return;
        }
        if (message.type === "PWA_OFFLINE_PACKAGE_CANCEL") {
          port.postMessage({
            type: "PWA_OFFLINE_CANCEL_ACK",
            protocol: 1,
            requestId: message.requestId,
            buildVersion: "0123456789abcdef",
            accepted: Boolean(startPort),
          });
          if (startPort && message.requestId === activeRequestId) {
            state =
              configuration.startBehavior === "cancel-complete"
                ? "complete"
                : "shell";
            startPort.postMessage(
              status(
                state === "complete"
                  ? "PWA_OFFLINE_COMPLETE"
                  : "PWA_OFFLINE_CANCELLED",
                message.requestId,
              ),
            );
            startPort = null;
          }
          return;
        }
        if (message.type !== "PWA_OFFLINE_PACKAGE_START") return;

        startCount += 1;
        activeRequestId = message.requestId;
        const downloadRequestId = message.requestId;
        startPort = port;
        state = "partial";
        port.postMessage({
          type: "PWA_OFFLINE_PROGRESS",
          protocol: 1,
          requestId: message.requestId,
          buildVersion: "0123456789abcdef",
          phase: "checking",
          processedEntries: 1,
          cachedEntries: 1,
          cachedBytes: 1024 * 1024,
          downloadedEntries: 0,
          downloadedBytes: 0,
          completedEntries: 1,
          completedBytes: 1024 * 1024,
          totalEntries,
          totalBytes,
        });

        if (
          configuration.startBehavior === "cancel" ||
          configuration.startBehavior === "cancel-complete" ||
          (configuration.startBehavior === "fail-once" && startCount === 1)
        ) {
          if (configuration.startBehavior === "fail-once") {
            port.postMessage({
              type: "PWA_OFFLINE_ERROR",
              protocol: 1,
              requestId: message.requestId,
              buildVersion: "0123456789abcdef",
              code: "network",
              retryable: true,
            });
            startPort = null;
          }
          return;
        }

        window.setTimeout(() => {
          state = "complete";
          port.postMessage({
            type: "PWA_OFFLINE_PROGRESS",
            protocol: 1,
            requestId: downloadRequestId,
            buildVersion: "0123456789abcdef",
            phase: "downloading",
            processedEntries: totalEntries,
            cachedEntries: 1,
            cachedBytes: 1024 * 1024,
            downloadedEntries: 4,
            downloadedBytes: 4 * 1024 * 1024,
            completedEntries: totalEntries,
            completedBytes: totalBytes,
            totalEntries,
            totalBytes,
          });
          port.postMessage(status("PWA_OFFLINE_COMPLETE", downloadRequestId));
          startPort = null;
        }, 30);
      },
    };
    const waitingWorker = configuration.waitingUpdate
      ? {
          state: "installed",
          postMessage(message: RequestMessage) {
            messages.push({ ...message });
          },
        }
      : null;
    const registration = Object.assign(new EventTarget(), {
      active: activeWorker,
      installing: null,
      waiting: waitingWorker,
      update: () => Promise.resolve(),
    });

    Reflect.defineProperty(container, "controller", {
      configurable: true,
      value: activeWorker,
    });
    Reflect.defineProperty(container, "ready", {
      configurable: true,
      value: Promise.resolve(registration),
    });
    Reflect.defineProperty(container, "register", {
      configurable: true,
      value: () => Promise.resolve(registration),
    });
    Reflect.set(window, "__pwaMockMessages", messages);
    const estimate = () =>
      Promise.resolve({ usage: 1024 * 1024, quota: 10 * 1024 * 1024 });
    const storage = Reflect.get(navigator, "storage");
    const estimateInstalled =
      typeof storage === "object" &&
      storage !== null &&
      Reflect.defineProperty(storage, "estimate", {
        configurable: true,
        value: estimate,
      });
    if (!estimateInstalled) {
      Reflect.defineProperty(navigator, "storage", {
        configurable: true,
        value: { estimate },
      });
    }
  }, options);
}

async function waitForMockPackageClient(page: Page) {
  await expect(page.locator("[data-pwa-offline-center]")).toHaveAttribute(
    "data-pwa-client-ready",
    "true",
  );
}

async function disableServiceWorkerRegistration(page: Page) {
  await page.addInitScript(() => {
    const serviceWorker = Reflect.get(navigator, "serviceWorker");
    if (!serviceWorker || typeof serviceWorker !== "object") return;

    Reflect.defineProperty(serviceWorker, "register", {
      configurable: true,
      value: () =>
        Promise.reject(
          new Error("Service Worker disabled by the install UI test."),
        ),
    });
  });
}

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

  const privacyManifestLink = page.locator(
    'link[rel="alternate"][type="application/json"][title="Privacy manifest"]',
  );
  await expect(privacyManifestLink).toHaveAttribute(
    "href",
    "/online-tools-hub/privacy-manifest.json",
  );
  const privacyManifestResponse = await request.get(
    "/online-tools-hub/privacy-manifest.json",
  );
  expect(privacyManifestResponse.ok()).toBe(true);
  expect(privacyManifestResponse.headers()["content-type"]).toContain(
    "application/json",
  );
  const privacyManifest = (await privacyManifestResponse.json()) as {
    format: string;
    version: number;
    inventory: {
      tools: unknown[];
      operations: unknown[];
      workflows: unknown[];
    };
  };
  expect(privacyManifest).toMatchObject({
    format: "online-tools-hub/privacy-manifest",
    version: 1,
  });
  expect(privacyManifest.inventory.tools).toHaveLength(13);
  expect(privacyManifest.inventory.operations).toHaveLength(13);
  expect(privacyManifest.inventory.workflows).toHaveLength(6);
});

test("安装按钮只在浏览器提供安装事件后出现", async ({ page }) => {
  await disableServiceWorkerRegistration(page);
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
  await disableServiceWorkerRegistration(page);
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

test("页脚离线入口渐进增强为可恢复焦点的容量管理面板", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await installMockPwaWorker(page);
  await page.goto("./", { waitUntil: "domcontentloaded" });
  await waitForMockPackageClient(page);

  expect(
    await page.evaluate(() => {
      const messages = Reflect.get(window, "__pwaMockMessages");
      return Array.isArray(messages)
        ? messages.filter((message) => message.type === "PWA_OFFLINE_STATUS")
            .length
        : 0;
    }),
  ).toBe(0);

  const { dialog, trigger } = await openOfflineCenter(page);
  await expect(
    dialog.getByRole("heading", { name: "基础离线页面已就绪" }),
  ).toBeVisible();
  await expect(dialog).toContainText("5.0 MiB");
  await expect(dialog).toContainText("5 项");
  await expect(dialog).toContainText("浏览器估算还可用约 9.0 MiB");
  await expect(
    dialog.getByRole("button", { name: "下载完整离线包" }),
  ).toBeEnabled();
  expect(
    await dialog.evaluate(
      (element) => getComputedStyle(element).transitionDuration,
    ),
  ).toBe("0s");
  expect(
    await page.evaluate(() => {
      const messages = Reflect.get(window, "__pwaMockMessages");
      return Array.isArray(messages)
        ? messages.filter((message) => message.type === "PWA_OFFLINE_STATUS")
            .length
        : 0;
    }),
  ).toBe(1);

  await dialog.getByRole("button", { name: "关闭面板" }).click();
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();
});

test("首次状态查询失败后可以重新检查", async ({ page }) => {
  await installMockPwaWorker(page, { statusBehavior: "fail-once" });
  await page.goto("./", { waitUntil: "domcontentloaded" });
  await waitForMockPackageClient(page);
  const { dialog } = await openOfflineCenter(page);

  await expect(dialog.getByRole("alert")).toContainText("网络中断");
  const retry = dialog.getByRole("button", {
    name: "重新检查离线包状态",
  });
  await expect(retry).toBeEnabled();
  await retry.click();
  await expect(
    dialog.getByRole("heading", { name: "基础离线页面已就绪" }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "下载完整离线包" }),
  ).toBeEnabled();
});

test("完整离线包下载可以主动取消", async ({ page }) => {
  await installMockPwaWorker(page, { startBehavior: "cancel" });
  await page.goto("./", { waitUntil: "domcontentloaded" });
  await waitForMockPackageClient(page);
  const { dialog } = await openOfflineCenter(page);

  await dialog.getByRole("button", { name: "下载完整离线包" }).click();
  await expect(dialog.getByRole("progressbar")).toBeVisible();
  await dialog.getByRole("button", { name: "取消下载" }).click();
  await expect(dialog).toContainText("下载已取消");
  await expect(
    dialog.getByRole("heading", { name: "基础离线页面已就绪" }),
  ).toBeVisible();
});

test("关闭并重新打开面板仍可查看并取消进行中的下载", async ({ page }) => {
  await installMockPwaWorker(page, { startBehavior: "cancel" });
  await page.goto("./", { waitUntil: "domcontentloaded" });
  await waitForMockPackageClient(page);
  const firstOpen = await openOfflineCenter(page);

  await firstOpen.dialog
    .getByRole("button", { name: "下载完整离线包" })
    .click();
  await expect(
    firstOpen.dialog.getByRole("button", { name: "取消下载" }),
  ).toBeVisible();
  await firstOpen.dialog.getByRole("button", { name: "关闭面板" }).click();
  await expect(firstOpen.dialog).not.toBeVisible();

  const secondOpen = await openOfflineCenter(page);
  await expect(
    secondOpen.dialog.getByRole("button", { name: "取消下载" }),
  ).toBeVisible();
  await secondOpen.dialog.getByRole("button", { name: "取消下载" }).click();
  await expect(secondOpen.dialog).toContainText("下载已取消");
});

test("取消竞态若完整包已校验则显示成功终态", async ({ page }) => {
  await installMockPwaWorker(page, { startBehavior: "cancel-complete" });
  await page.goto("./", { waitUntil: "domcontentloaded" });
  await waitForMockPackageClient(page);
  const { dialog } = await openOfflineCenter(page);

  await dialog.getByRole("button", { name: "下载完整离线包" }).click();
  await dialog.getByRole("button", { name: "取消下载" }).click();
  await expect(
    dialog.getByRole("heading", { name: "完整离线包已就绪" }),
  ).toBeVisible();
  await expect(dialog).toContainText("完整离线包已经校验并启用");
  await expect(dialog).not.toContainText("未完成的资源没有作为完整离线包启用");
});

test("完整离线包失败后可以重试并主动移除", async ({ page }) => {
  await installMockPwaWorker(page, { startBehavior: "fail-once" });
  await page.goto("./", { waitUntil: "domcontentloaded" });
  await waitForMockPackageClient(page);
  const { dialog } = await openOfflineCenter(page);
  await dialog.getByRole("button", { name: "下载完整离线包" }).click();
  await expect(dialog.getByRole("alert")).toContainText("网络中断");
  await dialog.getByRole("button", { name: "重新下载" }).click();
  await expect(
    dialog.getByRole("heading", { name: "完整离线包已就绪" }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "移除完整离线包" }).click();
  await expect(
    dialog.getByRole("heading", { name: "基础离线页面已就绪" }),
  ).toBeVisible();
  await expect(dialog).toContainText("完整离线包已移除");
});

test("已有部分缓存可以继续下载到完整终态", async ({ page }) => {
  await installMockPwaWorker(page, { initialState: "partial" });
  await page.goto("./", { waitUntil: "domcontentloaded" });
  await waitForMockPackageClient(page);
  const { dialog } = await openOfflineCenter(page);

  await expect(
    dialog.getByRole("heading", { name: "离线包尚未完成" }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "继续下载完整离线包" }).click();
  await expect(
    dialog.getByRole("heading", { name: "完整离线包已就绪" }),
  ).toBeVisible();
});

test("版本更新在发送 SKIP_WAITING 前明确警告工作区会消失", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await installMockPwaWorker(page, { waitingUpdate: true });
  await page.goto("./tools/json-formatter/", {
    waitUntil: "domcontentloaded",
  });
  await waitForMockPackageClient(page);

  const notice = page.locator('[data-pwa-notice="update"]');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText(
    "未清空的输入、结果、文件、批处理队列和运行进度都会消失",
  );
  await expect(notice).toContainText("更新后完整离线包可能需要重新下载");
  expect(
    await notice.evaluate(
      (element) => getComputedStyle(element).transitionDuration,
    ),
  ).toBe("0s");
  expect(
    await page.evaluate(() => {
      const messages = Reflect.get(window, "__pwaMockMessages");
      return Array.isArray(messages)
        ? messages.filter((message) => message.type === "SKIP_WAITING").length
        : 0;
    }),
  ).toBe(0);

  await page.setViewportSize({ width: 360, height: 800 });
  const noticeBounds = await notice.boundingBox();
  expect(noticeBounds).not.toBeNull();
  expect(noticeBounds!.x).toBeGreaterThanOrEqual(0);
  expect(noticeBounds!.x + noticeBounds!.width).toBeLessThanOrEqual(361);
  for (const button of await notice.getByRole("button").all()) {
    expect((await button.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  }
  const axe = await new AxeBuilder({ page })
    .include('[data-pwa-notice="update"]')
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(
    axe.violations.filter(
      (violation) =>
        violation.impact === "serious" || violation.impact === "critical",
    ),
  ).toEqual([]);

  const updateButton = notice.getByRole("button", {
    name: "仍要更新并重新载入",
  });
  await updateButton.focus();
  await expect(updateButton).toBeFocused();
  await updateButton.click();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const messages = Reflect.get(window, "__pwaMockMessages");
        return Array.isArray(messages)
          ? messages.filter((message) => message.type === "SKIP_WAITING").length
          : 0;
      }),
    )
    .toBe(1);
});

test("隐私能力中心发布完整边界并只在点击后运行无 canary 报告", async ({
  browserName,
  page,
}) => {
  test.skip(browserName !== "chromium", "真实合成自检由 Chromium 门禁验证");
  test.setTimeout(60_000);

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("./privacy/", { waitUntil: "networkidle" });
  await expect(
    page.getByRole("heading", { level: 1, name: "隐私边界，公开可验证" }),
  ).toBeVisible();
  await expect(page.locator("#capabilities")).toContainText("13 个工具运行时");
  await expect(page.locator("#capabilities")).toContainText(
    "数据库名称，但不读取其中的记录值",
  );
  await expect(page.locator("#capabilities")).toContainText(
    "通过不等于第三方安全认证",
  );

  const selfTest = page.locator("[data-privacy-self-test]");
  await selfTest.scrollIntoViewIfNeeded();
  await expect(selfTest).toHaveAttribute("data-self-test-state", "idle");
  const runButton = selfTest.getByRole("button", { name: "运行本地自检" });
  expect(
    await runButton.evaluate(
      (element) => getComputedStyle(element).transitionDuration,
    ),
  ).toBe("0s");
  await runButton.click();
  await expect(selfTest).toHaveAttribute("data-self-test-state", "complete", {
    timeout: 40_000,
  });
  await expect(selfTest).toContainText("本次自检的全部本站检查均已通过");
  await expect(selfTest).not.toContainText("OTH_PRIVACY_SELF_TEST_");
  await expect(selfTest.locator("[data-check-result='passed']")).toHaveCount(8);
});

test("隐私自检取消是明确的未通过终态", async ({ browserName, page }) => {
  test.skip(browserName !== "chromium", "真实自检取消由 Chromium 门禁验证");
  test.setTimeout(60_000);

  await page.goto("./privacy/", { waitUntil: "networkidle" });
  const selfTest = page.locator("[data-privacy-self-test]");
  await selfTest.scrollIntoViewIfNeeded();
  await selfTest.getByRole("button", { name: "运行本地自检" }).click();
  const cancel = selfTest.getByRole("button", { name: "取消自检" });
  await expect(cancel).toBeVisible();
  await cancel.click();
  await expect(selfTest).toHaveAttribute("data-self-test-state", "complete", {
    timeout: 40_000,
  });
  await expect(selfTest).toContainText("自检已取消");
  await expect(selfTest).toContainText("未通过");
  await expect(selfTest).not.toContainText("OTH_PRIVACY_SELF_TEST_");
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
  await waitForServiceWorkerControl(page);
  await downloadCompleteOfflinePackage(page);

  await context.setOffline(true);
  await page.goto("./tools/json-formatter/", {
    waitUntil: "domcontentloaded",
  });
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "JSON 格式化与校验",
      exact: true,
    }),
  ).toBeVisible();

  await page.goto("./tools/regex-tester/", {
    waitUntil: "domcontentloaded",
  });
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "正则表达式测试器",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.locator('[data-tool-workspace="regex-tester"]'),
  ).toBeVisible();
  await page
    .getByLabel("Pattern", { exact: true })
    .fill(String.raw`(?<word>\p{L}+)`);
  await page.getByLabel("测试文本", { exact: true }).fill("离线 Worker 可用");
  await page.getByRole("button", { name: "运行正则测试" }).click();
  await expect(page.locator("[data-regex-status]")).toContainText("测试完成", {
    timeout: 10_000,
  });
  await expect(page.locator(".regex-tool__matches")).toContainText("离线");

  await page.goto("./workflows/new/", {
    waitUntil: "domcontentloaded",
  });
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "从空白创建你的本地工作流",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.locator("[data-workflow-studio]")).toBeVisible();

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
  await waitForServiceWorkerControl(page);
  await downloadCompleteOfflinePackage(page);

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
      name.startsWith("online-tools-hub-"),
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
      methods: requests.map((request) => request.method),
      expectedPrefix: new URL("/online-tools-hub/", window.location.href).href,
      containsPrivateValue: responseBodies.some((body) =>
        body.includes(privateValue),
      ),
    };
  }, sentinel);

  expect(result.cacheNames.length).toBeGreaterThanOrEqual(1);
  expect(
    result.cacheNames.some((name) =>
      name.startsWith("online-tools-hub-shell-"),
    ),
  ).toBe(true);
  expect(result.urls.length).toBeGreaterThan(0);
  expect(result.methods.every((method) => method === "GET")).toBe(true);
  expect(result.urls.every((value) => new URL(value).search === "")).toBe(true);
  expect(
    result.urls.every((value) => value.startsWith(result.expectedPrefix)),
  ).toBe(true);
  expect(result.urls.some((value) => value.includes(sentinel))).toBe(false);
  expect(result.containsPrivateValue).toBe(false);
});

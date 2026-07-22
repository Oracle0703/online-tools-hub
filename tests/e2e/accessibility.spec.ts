import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const accessibilityRoutes = [
  { name: "首页", path: "./" },
  { name: "工具目录", path: "./tools/" },
  { name: "隐私说明", path: "./privacy/" },
  { name: "JSON", path: "./tools/json-formatter/" },
  { name: "Base64", path: "./tools/base64-codec/" },
  { name: "URL", path: "./tools/url-codec/" },
  { name: "时间戳", path: "./tools/unix-timestamp/" },
  { name: "UUID", path: "./tools/uuid-generator/" },
  { name: "图片压缩", path: "./tools/image-compressor/" },
  { name: "二维码", path: "./tools/qr-code/" },
  { name: "文本差异", path: "./tools/text-diff/" },
  { name: "正则测试", path: "./tools/regex-tester/" },
  { name: "SHA 哈希", path: "./tools/hash-generator/" },
  { name: "YAML / JSON", path: "./tools/yaml-json-converter/" },
  { name: "JWT", path: "./tools/jwt-decoder/" },
  { name: "CSV / JSON", path: "./tools/csv-json-converter/" },
  { name: "查询参数", path: "./tools/query-params/" },
  { name: "工作流目录", path: "./workflows/" },
  { name: "自定义工作流", path: "./workflows/new/" },
  {
    name: "Base64 JSON 工作流",
    path: "./workflows/base64-json-inspect/",
  },
  {
    name: "图片哈希工作流",
    path: "./workflows/png-palette-sha256/",
  },
  { name: "知识中心", path: "./guides/" },
];

test.describe("axe 无障碍发布门禁", () => {
  for (const route of accessibilityRoutes) {
    test(`${route.name} 无 serious 或 critical 问题`, async ({
      page,
    }, testInfo) => {
      await page.goto(route.path, { waitUntil: "networkidle" });

      if (route.path.startsWith("./tools/") && route.path !== "./tools/") {
        await expect(page.locator("[data-tool-workspace]")).toBeVisible();
      }

      const result = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze();
      const blockers = result.violations.filter(
        (violation) =>
          violation.impact === "serious" || violation.impact === "critical",
      );

      if (blockers.length > 0) {
        await testInfo.attach("axe-blockers", {
          body: JSON.stringify(blockers, null, 2),
          contentType: "application/json",
        });
      }

      expect(blockers).toEqual([]);
    });
  }

  test("键盘可以完成 JSON 核心流程，状态会向辅助技术播报", async ({ page }) => {
    await page.goto("./tools/json-formatter/", {
      waitUntil: "domcontentloaded",
    });

    await expect(
      page.locator('[data-tool-workspace="json-formatter"]'),
    ).toBeVisible();

    const input = page.getByLabel("输入", { exact: true });
    await input.focus();
    await page.keyboard.type('{"keyboard":true}');
    await page.keyboard.press("ControlOrMeta+Enter");

    await expect(page.getByLabel("输出", { exact: true })).toHaveValue(
      /"keyboard": true/u,
    );
    const status = page.getByRole("status");
    await expect(status).toContainText("格式化完成");
    await expect(status).toHaveAttribute("aria-live", "polite");

    await page.keyboard.press("Tab");
    await expect(page.locator(":focus-visible")).toBeVisible();
  });

  test("二维码扫描模式只有可见拖放区进入键盘顺序且无阻断问题", async ({
    page,
  }, testInfo) => {
    await page.goto("./tools/qr-code/", { waitUntil: "networkidle" });
    await page.getByRole("radio", { name: /识别图片/u }).check();

    const fileInput = page.locator(".qr-tool__file-input");
    await expect(fileInput).toHaveAttribute("aria-label", "选择二维码图片文件");
    await expect(fileInput).toHaveAttribute("tabindex", "-1");

    const dropzone = page.getByRole("button", {
      name: /选择或拖入一张图片/u,
    });
    await dropzone.focus();
    await expect(dropzone).toBeFocused();

    const result = await new AxeBuilder({ page })
      .include('[data-tool-workspace="qr-code"]')
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    const blockers = result.violations.filter(
      (violation) =>
        violation.impact === "serious" || violation.impact === "critical",
    );
    if (blockers.length > 0) {
      await testInfo.attach("qr-scan-axe-blockers", {
        body: JSON.stringify(blockers, null, 2),
        contentType: "application/json",
      });
    }
    expect(blockers).toEqual([]);
  });

  test("主题选择与主要导航具有可访问名称和键盘焦点", async ({ page }) => {
    await page.goto("./", { waitUntil: "domcontentloaded" });

    await expect(
      page.getByRole("navigation", { name: "主导航" }),
    ).toBeVisible();
    await expect(page.getByLabel("主题模式")).toBeVisible();
    await page.getByLabel("主题模式").focus();
    await page.getByLabel("主题模式").selectOption("dark");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  });

  test("隐私能力中心与打开的离线面板无阻断问题且关闭后恢复焦点", async ({
    page,
  }, testInfo) => {
    await page.goto("./privacy/", { waitUntil: "networkidle" });
    const capabilityCenter = page.locator("[data-privacy-self-test]");
    await expect(capabilityCenter).toBeVisible();

    const capabilityResult = await new AxeBuilder({ page })
      .include("[data-privacy-self-test]")
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    const capabilityBlockers = capabilityResult.violations.filter(
      (violation) =>
        violation.impact === "serious" || violation.impact === "critical",
    );
    expect(capabilityBlockers).toEqual([]);

    const supportsServiceWorker = await page.evaluate(
      () => "serviceWorker" in navigator,
    );
    test.skip(!supportsServiceWorker, "浏览器不支持 Service Worker");
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    await page.reload({ waitUntil: "networkidle" });
    await expect(page.locator("[data-pwa-offline-center]")).toHaveAttribute(
      "data-pwa-client-ready",
      "true",
    );

    const trigger = page
      .locator("[data-pwa-offline-trigger]")
      .filter({ hasText: "离线使用" })
      .first();
    const dialog = page.locator("[data-pwa-offline-center]");
    await trigger.click();
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "关闭离线使用面板" }),
    ).toBeFocused();

    const dialogResult = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    const dialogBlockers = dialogResult.violations.filter(
      (violation) =>
        violation.impact === "serious" || violation.impact === "critical",
    );
    if (dialogBlockers.length > 0) {
      await testInfo.attach("pwa-dialog-axe-blockers", {
        body: JSON.stringify(dialogBlockers, null, 2),
        contentType: "application/json",
      });
    }
    expect(dialogBlockers).toEqual([]);

    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    await expect(trigger).toBeFocused();

    await trigger.click();
    await dialog.getByRole("button", { name: "关闭面板" }).click();
    await expect(dialog).not.toBeVisible();
    await expect(trigger).toBeFocused();
  });
});

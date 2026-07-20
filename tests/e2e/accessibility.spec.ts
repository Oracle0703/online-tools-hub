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
  { name: "文本差异", path: "./tools/text-diff/" },
  { name: "SHA 哈希", path: "./tools/hash-generator/" },
  { name: "YAML / JSON", path: "./tools/yaml-json-converter/" },
  { name: "JWT", path: "./tools/jwt-decoder/" },
  { name: "CSV / JSON", path: "./tools/csv-json-converter/" },
  { name: "查询参数", path: "./tools/query-params/" },
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
});

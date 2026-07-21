import { expect, test, type Locator, type Page } from "@playwright/test";

const TOOL_MEMORY_KEY = "online-tools-hub:tool-memory:v1";

async function openGlobalSearch(page: Page) {
  const trigger = page.getByRole("button", {
    name: "搜索工具、指南和常见任务",
  });
  const island = page.locator(
    'astro-island[component-url*="GlobalToolSearch"]',
  );

  await expect(trigger).toBeVisible();
  await expect(island).toHaveCount(1);
  await expect.poll(() => island.getAttribute("ssr")).toBeNull();
  await trigger.click();

  const dialog = page.getByRole("dialog", {
    name: "搜索工具、指南与任务",
  });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function expectTouchTarget(locator: Locator) {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeGreaterThanOrEqual(44);
  expect(box!.height).toBeGreaterThanOrEqual(44);
}

test("全站搜索支持按钮、快捷键、直接跳转与关闭", async ({ page }) => {
  await page.goto("./", { waitUntil: "domcontentloaded" });
  const dialog = await openGlobalSearch(page);

  const input = dialog.getByRole("combobox", {
    name: "搜索工具、指南和常见任务",
  });
  await input.fill("图片压缩");
  const imageTool = dialog
    .getByRole("group", { name: "工具" })
    .getByRole("option", { name: /图片压缩/u });
  await expect(imageTool).toHaveCount(1);
  await imageTool.click();
  await expect(page).toHaveURL(/\/tools\/image-compressor\/$/u);
  await page.waitForLoadState("networkidle");

  await page.keyboard.press("Control+k");
  await expect(dialog).toBeVisible();
  await dialog
    .getByRole("combobox", { name: "搜索工具、指南和常见任务" })
    .fill("JSON");
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
});

test("搜索结果按快捷工具、工具、指南和常见任务分组", async ({ page }) => {
  await page.addInitScript(
    ({ key }) => {
      window.localStorage.setItem(
        key,
        JSON.stringify({
          version: 1,
          favorites: [{ slug: "jwt-decoder", at: 30 }],
          recent: [
            { slug: "json-formatter", at: 20 },
            { slug: "jwt-decoder", at: 10 },
          ],
        }),
      );
    },
    { key: TOOL_MEMORY_KEY },
  );
  await page.goto("./", { waitUntil: "domcontentloaded" });
  const dialog = await openGlobalSearch(page);

  const shortcuts = dialog.getByRole("group", { name: "收藏 / 最近" });
  await expect(shortcuts.getByRole("option")).toHaveCount(2);
  await expect(shortcuts.getByRole("option").first()).toContainText("JWT 解码");
  await expect(dialog.getByRole("group", { name: "工具" })).toBeVisible();
  await expect(dialog.getByRole("group", { name: "指南" })).toBeVisible();
  await expect(dialog.getByRole("group", { name: "常见任务" })).toBeVisible();

  const input = dialog.getByRole("combobox", {
    name: "搜索工具、指南和常见任务",
  });
  await expect(input).toHaveAttribute("aria-controls", "global-search-listbox");
  await expect(input).toHaveAttribute(
    "aria-describedby",
    "global-search-summary",
  );
  await input.fill("令牌过期");
  await expect(
    dialog
      .getByRole("group", { name: "常见任务" })
      .getByRole("option", { name: /查看 JWT 为什么看起来已经过期/u }),
  ).toBeVisible();

  await input.fill("前导零");
  await expect(
    dialog
      .getByRole("group", { name: "常见任务" })
      .getByRole("option", { name: /把表格导出的 CSV 变成接口样例/u }),
  ).toBeVisible();

  await input.fill("完全不存在 xyz987");
  await expect(dialog.getByText("没有匹配的工具、指南或任务")).toBeVisible();
  await expect(input).not.toHaveAttribute("aria-activedescendant", /.+/u);
  await expect(dialog.locator("#global-search-listbox")).toHaveCount(1);
});

test("上下键选择结果，Enter 打开，输入焦点留在搜索框", async ({ page }) => {
  await page.goto("./", { waitUntil: "domcontentloaded" });
  const dialog = await openGlobalSearch(page);
  const input = dialog.getByRole("combobox", {
    name: "搜索工具、指南和常见任务",
  });

  await input.fill("Base64");
  await expect(input).toBeFocused();
  await expect(input).toHaveAttribute(
    "aria-activedescendant",
    /global-search-option-tool-base64-codec$/u,
  );

  await input.press("ArrowDown");
  await expect(input).toBeFocused();
  await expect(input).toHaveAttribute(
    "aria-activedescendant",
    /global-search-option-guide-base64-is-not-encryption$/u,
  );

  await input.press("ArrowUp");
  await expect(input).toHaveAttribute(
    "aria-activedescendant",
    /global-search-option-tool-base64-codec$/u,
  );
  await input.press("ArrowDown");
  await input.press("Enter");
  await expect(page).toHaveURL(/\/guides\/base64-is-not-encryption\/$/u);
});

test("工作流可被全站搜索发现并直接进入公开模板页", async ({ page }) => {
  await page.goto("./", { waitUntil: "domcontentloaded" });
  const dialog = await openGlobalSearch(page);
  const input = dialog.getByRole("combobox", {
    name: "搜索工具、指南和常见任务",
  });

  await input.fill("JWT 工作流");
  const workflow = dialog
    .getByRole("group", { name: "常见任务" })
    .getByRole("option", { name: /URL 编码 JWT 声明报告/u });
  await expect(workflow).toBeVisible();
  await workflow.click();
  await expect(page).toHaveURL(/\/workflows\/encoded-jwt-claims\/$/u);
});

test("360px 下搜索面板和触控目标完整可用且没有横向溢出", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto("./", { waitUntil: "domcontentloaded" });

  const trigger = page.getByRole("button", {
    name: "搜索工具、指南和常见任务",
  });
  await expectTouchTarget(trigger);
  const dialog = await openGlobalSearch(page);
  const close = dialog.getByRole("button", { name: "关闭全站搜索" });
  const input = dialog.getByRole("combobox", {
    name: "搜索工具、指南和常见任务",
  });

  await expectTouchTarget(close);
  await expectTouchTarget(input);
  await input.fill("令牌过期");

  const firstResult = dialog.getByRole("option").first();
  await expect(firstResult).toBeVisible();
  await expectTouchTarget(firstResult);
  await expect(
    dialog.getByText("工作流 / 常见任务", { exact: true }),
  ).toBeVisible();

  const layout = await dialog.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const results = element.querySelector<HTMLElement>(
      ".global-search-results",
    );
    return {
      left: rect.left,
      right: rect.right,
      dialogClientWidth: element.clientWidth,
      dialogScrollWidth: element.scrollWidth,
      resultsClientWidth: results?.clientWidth ?? 0,
      resultsScrollWidth: results?.scrollWidth ?? 0,
      documentScrollWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
    };
  });

  expect(layout.left).toBeGreaterThanOrEqual(0);
  expect(layout.right).toBeLessThanOrEqual(layout.viewportWidth);
  expect(layout.dialogScrollWidth).toBeLessThanOrEqual(
    layout.dialogClientWidth,
  );
  expect(layout.resultsScrollWidth).toBeLessThanOrEqual(
    layout.resultsClientWidth,
  );
  expect(layout.documentScrollWidth).toBeLessThanOrEqual(layout.viewportWidth);
});

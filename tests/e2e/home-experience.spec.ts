import { expect, test } from "@playwright/test";

const TOOL_MEMORY_KEY = "online-tools-hub:tool-memory:v1";

test.describe("首页内容与本地快捷工具", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("./", { waitUntil: "networkidle" });
  });

  test("实时预览使用正式核心逻辑并切换完整工具链接", async ({ page }) => {
    const preview = page.getByRole("region", {
      name: "输入一点，立即看到结果",
    });
    await expect(preview).toBeVisible();

    await preview.getByLabel("输入").fill('{"ready":true,"count":10}');
    await expect(preview.getByLabel("JSON 格式化结果")).toContainText(
      '"ready": true',
    );
    await expect(preview.getByRole("status")).toContainText(
      "已在浏览器中实时格式化",
    );

    await preview.getByRole("tab", { name: "Base64" }).click();
    await preview.getByLabel("UTF-8 文本").fill("你好");
    await expect(preview.getByLabel("Base64 编码结果")).toContainText(
      "5L2g5aW9",
    );
    await expect(
      preview.getByRole("link", { name: "打开完整的Base64 编解码工具" }),
    ).toHaveAttribute("href", /\/tools\/base64-codec\/$/u);

    await preview.getByRole("tab", { name: "图片压缩" }).click();
    await expect(preview).toContainText("结果由真实文件计算");
  });

  test("首页展示十三个真实任务、指南与同源更新记录", async ({ page }) => {
    const recipes = page.getByRole("region", {
      name: "从问题出发，而不是从工具名出发",
    });
    await expect(recipes.locator(".task-recipes__grid > li")).toHaveCount(13);
    await expect(recipes).toContainText("把一整行接口响应整理到能读");
    await expect(recipes).toContainText("把一批截图压到适合上传的大小");
    await expect(recipes).toContainText("检查日志提取正则会不会卡住界面");
    await expect(recipes).toContainText("查看 JWT 为什么看起来已经过期");
    await expect(recipes).toContainText("把表格导出的 CSV 变成接口样例");
    await expect(recipes).toContainText("看清一条复杂链接究竟带了哪些参数");

    const updates = page.getByRole("region", { name: "最近更新" });
    await expect(updates.locator(".release-card")).toHaveCount(3);
    await expect(updates).toContainText("v0.8.0");
    await expect(updates).toContainText("离线数据工作台");
    await expect(
      page.getByRole("heading", { name: "不只给结果，也讲清边界" }),
    ).toBeVisible();
  });

  test("收藏和最近使用仅持久化工具标识与时间", async ({ page }) => {
    const directory = page.getByRole("region", {
      name: "工具搜索与筛选",
    });
    const favorite = directory.getByRole("button", {
      name: "收藏JSON 格式化",
    });
    await favorite.click();
    await expect(
      directory.getByRole("button", { name: "取消收藏JSON 格式化" }),
    ).toHaveAttribute("aria-pressed", "true");

    const shortcuts = page.getByRole("region", { name: "你的快捷工具" });
    await expect(shortcuts).toContainText("已收藏");
    await expect(
      shortcuts.getByRole("link", { name: /JSON 格式化/u }),
    ).toBeVisible();

    await page.reload({ waitUntil: "networkidle" });
    await expect(
      page
        .getByRole("region", { name: "工具搜索与筛选" })
        .getByRole("button", { name: "取消收藏JSON 格式化" }),
    ).toHaveAttribute("aria-pressed", "true");

    await page.getByRole("link", { name: "打开JSON 格式化与校验" }).click();
    await expect(page).toHaveURL(/\/tools\/json-formatter\/$/u);
    await expect
      .poll(() =>
        page.evaluate((key) => {
          const raw = window.localStorage.getItem(key) ?? "{}";
          const memory = JSON.parse(raw) as {
            recent?: Array<{ slug?: string }>;
          };
          return (
            memory.recent?.some((entry) => entry.slug === "json-formatter") ??
            false
          );
        }, TOOL_MEMORY_KEY),
      )
      .toBe(true);

    await page.goto("./", { waitUntil: "networkidle" });
    const memoryIsland = page.locator(
      'astro-island[component-url*="HomeToolMemory"]',
    );
    await expect(memoryIsland).toHaveCount(1);
    await expect.poll(() => memoryIsland.getAttribute("ssr")).toBeNull();
    await expect(
      page
        .getByRole("region", { name: "你的快捷工具" })
        .getByRole("heading", { name: "最近使用" }),
    ).toBeVisible();

    const stored = await page.evaluate((key) => {
      const raw = window.localStorage.getItem(key) ?? "{}";
      return { raw, value: JSON.parse(raw) as Record<string, unknown> };
    }, TOOL_MEMORY_KEY);
    expect(Object.keys(stored.value).sort()).toEqual([
      "favorites",
      "recent",
      "version",
    ]);
    expect(stored.raw).not.toContain("input");
    expect(stored.raw).not.toContain("result");
  });
});

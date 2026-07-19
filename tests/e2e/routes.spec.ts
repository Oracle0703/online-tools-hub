import { expect, test } from "@playwright/test";

const routes = [
  { name: "首页", path: "./" },
  { name: "隐私说明", path: "./privacy/" },
  { name: "JSON 工具", path: "./tools/json-formatter/" },
] as const;

for (const route of routes) {
  test(`${route.name}可通过项目 base 路径直接访问`, async ({ page }) => {
    const response = await page.goto(route.path, {
      waitUntil: "domcontentloaded",
    });

    expect(response, `${route.name}应返回文档响应`).not.toBeNull();
    expect(response?.ok(), `${route.name}不应返回 4xx/5xx`).toBe(true);
    await expect(page.locator("main")).toBeVisible();
    await expect(page.locator("h1").first()).toBeVisible();
  });
}

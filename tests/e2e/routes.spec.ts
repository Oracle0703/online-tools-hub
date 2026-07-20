import { expect, test } from "@playwright/test";

const routes = [
  { name: "首页", path: "./" },
  { name: "隐私说明", path: "./privacy/" },
  { name: "JSON 工具", path: "./tools/json-formatter/" },
  { name: "Base64 工具", path: "./tools/base64-codec/" },
  { name: "URL 工具", path: "./tools/url-codec/" },
  { name: "时间戳工具", path: "./tools/unix-timestamp/" },
  { name: "UUID 工具", path: "./tools/uuid-generator/" },
  { name: "图片压缩工具", path: "./tools/image-compressor/" },
  { name: "文本差异工具", path: "./tools/text-diff/" },
  { name: "SHA 哈希工具", path: "./tools/hash-generator/" },
  { name: "YAML JSON 工具", path: "./tools/yaml-json-converter/" },
  { name: "JWT 解码工具", path: "./tools/jwt-decoder/" },
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

test("未知工具 slug 返回静态 404，而不是空白工具壳", async ({ page }) => {
  const response = await page.goto("./tools/not-a-real-tool/", {
    waitUntil: "domcontentloaded",
  });

  expect(response?.status()).toBe(404);
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
    "content",
    "noindex, nofollow",
  );
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "这里没有这个工具",
  );
  await expect(page.locator("[data-tool-slug]")).toHaveCount(0);
});

test("十个工具页由 registry 生成并暴露统一 ToolShell 契约", async ({
  page,
}) => {
  for (const route of routes.filter(({ path }) =>
    path.startsWith("./tools/"),
  )) {
    await page.goto(route.path, { waitUntil: "domcontentloaded" });

    const shell = page.locator("[data-tool-slug]");
    await expect(shell).toHaveCount(1);
    await expect(shell).toHaveAttribute(
      "data-tool-capabilities",
      /(?:^| )input(?: |$)/u,
    );
    await expect(shell).toHaveAttribute(
      "data-tool-capabilities",
      /(?:^| )output(?: |$)/u,
    );
    await expect(shell).toHaveAttribute(
      "data-tool-capabilities",
      /(?:^| )execute(?: |$)/u,
    );
    await expect(shell).toHaveAttribute(
      "data-tool-capabilities",
      /(?:^| )clear(?: |$)/u,
    );
    await expect(page.locator('[data-tool-region="workspace"]')).toHaveCount(1);
    await expect(page.locator(".tool-workspace")).toHaveCount(1);
  }
});

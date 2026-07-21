import { expect, test } from "@playwright/test";

test("首页用可检查的步骤链推荐精选工作流", async ({ page }) => {
  await page.goto("./", { waitUntil: "domcontentloaded" });

  const section = page.getByRole("region", {
    name: "输入一次，按清楚的步骤完成整条任务",
  });
  await expect(section).toBeVisible();
  await expect(section.locator(".home-workflows__grid > li")).toHaveCount(3);

  const workflow = section.getByRole("link", {
    name: "打开工作流：解开 Base64 JSON",
  });
  await expect(workflow).toHaveAttribute(
    "href",
    /\/workflows\/base64-json-inspect\/$/u,
  );
  await expect(workflow).toContainText("标准 Base64 文本");
  await expect(workflow).toContainText("解码 Base64");
  await expect(workflow).toContainText("格式化 JSON 文本");

  const structuredLists = await page
    .locator('script[type="application/ld+json"]')
    .evaluateAll((scripts) =>
      scripts.flatMap((script) => {
        const value = JSON.parse(script.textContent ?? "null") as unknown;
        if (Array.isArray(value)) return value;
        if (
          value &&
          typeof value === "object" &&
          "@graph" in value &&
          Array.isArray((value as { "@graph": unknown[] })["@graph"])
        ) {
          return (value as { "@graph": unknown[] })["@graph"];
        }
        return [value];
      }),
    );
  expect(structuredLists).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        "@type": "ItemList",
        name: "精选浏览器本地工作流",
        numberOfItems: 3,
      }),
    ]),
  );
});

test("360px 下精选工作流保持单列且没有横向溢出", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto("./", { waitUntil: "domcontentloaded" });

  const section = page.getByRole("region", {
    name: "输入一次，按清楚的步骤完成整条任务",
  });
  const firstWorkflow = section.locator(".home-workflow").first();
  const box = await firstWorkflow.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeGreaterThanOrEqual(300);
  expect(box!.height).toBeGreaterThanOrEqual(44);

  const layout = await page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    documentScrollWidth: document.documentElement.scrollWidth,
  }));
  expect(layout.documentScrollWidth).toBeLessThanOrEqual(layout.viewportWidth);
});

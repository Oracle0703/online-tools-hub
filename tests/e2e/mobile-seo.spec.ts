import { Buffer } from "node:buffer";

import { expect, test, type Page } from "@playwright/test";

const indexableRoutes = [
  "./",
  "./tools/",
  "./categories/",
  "./categories/format-validation/",
  "./categories/encode-decode/",
  "./categories/time-identifiers/",
  "./categories/files-images/",
  "./tools/json-formatter/",
  "./tools/base64-codec/",
  "./tools/url-codec/",
  "./tools/unix-timestamp/",
  "./tools/uuid-generator/",
  "./tools/image-compressor/",
  "./privacy/",
  "./about/",
  "./changelog/",
] as const;

const toolRoutes = indexableRoutes.filter(
  (route) => route.startsWith("./tools/") && route !== "./tools/",
);
const noindexRoutes = [
  "./categories/text-processing/",
  "./categories/security-hash/",
] as const;
const mobileRoutes = [...indexableRoutes, ...noindexRoutes, "./404.html"];

async function findViewportOverflow(page: Page) {
  return page.evaluate(() => {
    const viewportWidth = document.documentElement.clientWidth;

    return [...document.body.querySelectorAll<HTMLElement>("*")]
      .filter((element) => {
        const style = getComputedStyle(element);
        if (
          style.display === "none" ||
          style.visibility === "hidden" ||
          element.getClientRects().length === 0
        ) {
          return false;
        }

        const rect = element.getBoundingClientRect();
        return rect.left < -1 || rect.right > viewportWidth + 1;
      })
      .slice(0, 10)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          tag: element.tagName.toLowerCase(),
          id: element.id,
          className:
            typeof element.className === "string" ? element.className : "",
          left: Math.round(rect.left),
          right: Math.round(rect.right),
        };
      });
  });
}

async function findSmallTouchTargets(page: Page) {
  return page.evaluate(() => {
    const selector = [
      "button",
      ".main-nav a",
      ".json-tool__segments span",
      ".base64-tool__segments span",
      ".url-tool__segments span",
      ".url-tool__form-option",
      ".timestamp-tool__segments span",
      ".image-compressor-tool__dropzone",
      ".image-compressor-tool__advanced summary",
      ".image-compressor-tool__quality > input[type=range]",
      ".image-compressor-tool__select",
      ".image-compressor-tool__select select",
      ".image-compressor-tool__color",
      ".image-compressor-tool__color input[type=color]",
    ].join(",");

    return [...document.querySelectorAll<HTMLElement>(selector)]
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return (
          element.getClientRects().length > 0 &&
          (rect.width < 43.5 || rect.height < 43.5)
        );
      })
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          text: element.textContent?.trim().slice(0, 30) ?? "",
          className: element.className,
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };
      });
  });
}

test.describe("移动端与 SEO 契约", () => {
  test.use({ viewport: { width: 360, height: 800 } });

  test("全部公开页面在 360px 下无横向溢出", async ({ page }) => {
    for (const route of mobileRoutes) {
      await page.goto(route, { waitUntil: "domcontentloaded" });

      const dimensions = await page.evaluate(() => ({
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
      }));

      expect(
        dimensions.scrollWidth,
        `${route} 不应超出 360px 视口`,
      ).toBeLessThanOrEqual(dimensions.clientWidth + 1);
      expect(
        await findViewportOverflow(page),
        `${route} 不应有被 overflow-x 裁切的子元素`,
      ).toEqual([]);
      await expect(page.locator("h1")).toHaveCount(1);
      await expect(page.locator("main")).toBeVisible();
    }
  });

  test("移动端关键触控目标至少为 44px", async ({ page }) => {
    for (const route of toolRoutes) {
      await page.goto(route, { waitUntil: "domcontentloaded" });
      expect(
        await findSmallTouchTargets(page),
        `${route} 触控目标过小`,
      ).toEqual([]);
    }

    await page.goto("./", { waitUntil: "domcontentloaded" });
    await page.getByRole("searchbox", { name: "搜索工具" }).fill("JSON");
    expect(
      await findSmallTouchTargets(page),
      "首页搜索控件触控目标过小",
    ).toEqual([]);
  });

  test("工具交互后的长结果和错误状态仍不溢出", async ({ page }) => {
    await page.goto("./tools/json-formatter/");
    await page.getByLabel("输入").fill(`{"long":"${"中文🙂".repeat(120)}"`);
    await page.getByRole("button", { name: "格式化", exact: true }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await page.getByRole("alert").locator("summary").click();
    expect(await findViewportOverflow(page)).toEqual([]);

    await page.goto("./tools/base64-codec/");
    await page.getByLabel("UTF-8 输入").fill("中文🙂".repeat(300));
    await page.getByRole("button", { name: "编码为 Base64" }).click();
    await expect(page.getByLabel("编码结果")).not.toHaveValue("");
    expect(await findViewportOverflow(page)).toEqual([]);

    await page.goto("./tools/url-codec/");
    await page.getByLabel("输入").fill(`%E4%B8${"x".repeat(220)}`);
    await page.getByRole("button", { name: "URL 解码" }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await page.getByRole("alert").locator("summary").click();
    expect(await findViewportOverflow(page)).toEqual([]);

    await page.goto("./tools/unix-timestamp/");
    await page
      .getByRole("textbox", { name: "Unix 时间戳", exact: true })
      .fill("0");
    await page.getByRole("button", { name: "转换时间戳" }).click();
    await expect(page.getByLabel("时间戳转换结果")).toBeVisible();
    expect(await findViewportOverflow(page)).toEqual([]);

    await page.goto("./tools/uuid-generator/");
    await page.getByLabel("生成数量").fill("1000");
    await page.getByRole("button", { name: "生成 UUID" }).click();
    await expect(page.locator(".uuid-tool__list li")).toHaveCount(1000, {
      timeout: 15_000,
    });
    expect(await findViewportOverflow(page)).toEqual([]);
    expect(await findSmallTouchTargets(page)).toEqual([]);

    await page.goto("./tools/image-compressor/", { waitUntil: "networkidle" });
    await page.getByLabel("选择 JPEG、PNG 或 WebP 图片").setInputFiles({
      name: "移动端-很长的图片文件名称-中文🙂.png",
      mimeType: "image/png",
      buffer: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAYAAAC09K7GAAAANUlEQVR4nBXIMREAMAgEwVdHHRF4SYMXbHxNg5zLZMuVxAktpWZ0kRIil8pm8ochvJSb8eUBpjAeBjxGdD0AAAAASUVORK5CYII=",
        "base64",
      ),
    });
    await page.getByRole("button", { name: "压缩 1 张图片" }).click();
    await expect(
      page.locator(".image-compressor-tool__feedback"),
    ).toContainText("已完成 1 张图片", { timeout: 30_000 });
    expect(await findViewportOverflow(page)).toEqual([]);
    expect(await findSmallTouchTargets(page)).toEqual([]);
  });

  test("公开页面提供可索引的唯一元数据", async ({ page }) => {
    const titles = new Set<string>();
    const canonicals = new Set<string>();

    for (const route of indexableRoutes) {
      await page.goto(route, { waitUntil: "domcontentloaded" });

      const metadata = await page.evaluate(() => ({
        title: document.title,
        description:
          document
            .querySelector<HTMLMetaElement>('meta[name="description"]')
            ?.getAttribute("content") ?? "",
        canonical:
          document
            .querySelector<HTMLLinkElement>('link[rel="canonical"]')
            ?.getAttribute("href") ?? "",
        robots:
          document
            .querySelector<HTMLMetaElement>('meta[name="robots"]')
            ?.getAttribute("content") ?? "",
        ogImage:
          document
            .querySelector<HTMLMetaElement>('meta[property="og:image"]')
            ?.getAttribute("content") ?? "",
      }));

      expect(metadata.title.length, `${route} 标题过短`).toBeGreaterThan(8);
      expect(metadata.description.length, `${route} 描述过短`).toBeGreaterThan(
        20,
      );
      expect(metadata.canonical).toMatch(
        /^https:\/\/oracle0703\.github\.io\/online-tools-hub\//u,
      );
      expect(metadata.robots).toContain("index, follow");
      expect(metadata.ogImage).toMatch(/\/online-tools-hub\/og-image\.png$/u);
      expect(titles.has(metadata.title), `${route} 标题应唯一`).toBe(false);
      expect(
        canonicals.has(metadata.canonical),
        `${route} canonical 应唯一`,
      ).toBe(false);
      titles.add(metadata.title);
      canonicals.add(metadata.canonical);
    }
  });

  test("路线图分类与 404 使用正确的 noindex 策略", async ({ page }) => {
    for (const route of noindexRoutes) {
      await page.goto(route, { waitUntil: "domcontentloaded" });
      await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
        "content",
        "noindex, nofollow",
      );
    }

    await page.goto("./404.html", { waitUntil: "domcontentloaded" });
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
      "content",
      "noindex, nofollow",
    );
    await expect(page.locator('link[rel="canonical"]')).toHaveCount(0);
    await expect(page.locator('link[rel="alternate"]')).toHaveCount(0);
  });

  test("工具页提供 WebApplication、FAQ 和面包屑结构化描述", async ({
    page,
  }) => {
    for (const route of toolRoutes) {
      await page.goto(route, { waitUntil: "domcontentloaded" });

      const graphTypes = await page
        .locator('script[type="application/ld+json"]')
        .evaluateAll((scripts) =>
          scripts.flatMap((script) => {
            const value = JSON.parse(script.textContent ?? "{}") as {
              "@graph"?: Array<{ "@type"?: string }>;
            };
            return (value["@graph"] ?? []).map((node) => node["@type"]);
          }),
        );

      expect(graphTypes).toEqual(
        expect.arrayContaining([
          "WebSite",
          "WebApplication",
          "FAQPage",
          "BreadcrumbList",
        ]),
      );
      await expect(page.locator(".faq-list details")).toHaveCount(3);
    }
  });
});

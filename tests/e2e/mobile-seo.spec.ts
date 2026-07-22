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
  "./categories/text-processing/",
  "./categories/security-hash/",
  "./tools/json-formatter/",
  "./tools/base64-codec/",
  "./tools/url-codec/",
  "./tools/unix-timestamp/",
  "./tools/uuid-generator/",
  "./tools/image-compressor/",
  "./tools/text-diff/",
  "./tools/regex-tester/",
  "./tools/hash-generator/",
  "./tools/yaml-json-converter/",
  "./tools/jwt-decoder/",
  "./tools/csv-json-converter/",
  "./tools/query-params/",
  "./guides/",
  "./guides/javascript-regex-redos-safety/",
  "./guides/base64-is-not-encryption/",
  "./guides/jwt-decode-vs-verify/",
  "./guides/verify-file-sha256/",
  "./guides/csv-json-data-safety/",
  "./guides/image-compression-quality-size/",
  "./guides/yaml-json-differences/",
  "./guides/url-query-parameters/",
  "./guides/local-browser-tools-privacy/",
  "./workflows/",
  "./workflows/new/",
  "./workflows/base64-json-inspect/",
  "./workflows/yaml-config-to-base64url/",
  "./workflows/csv-api-fixture-sha256/",
  "./workflows/encoded-callback-query-audit/",
  "./workflows/encoded-jwt-claims/",
  "./workflows/png-palette-sha256/",
  "./privacy/",
  "./about/",
  "./changelog/",
] as const;

const toolRoutes = indexableRoutes.filter(
  (route) => route.startsWith("./tools/") && route !== "./tools/",
);
const guideRoutes = indexableRoutes.filter(
  (route) => route.startsWith("./guides/") && route !== "./guides/",
);
const workflowRoutes = indexableRoutes.filter(
  (route) => route.startsWith("./workflows/") && route !== "./workflows/",
);
const noindexRoutes = [] as const;
const mobileRoutes = [...indexableRoutes, ...noindexRoutes, "./404.html"];

async function findViewportOverflow(page: Page) {
  return page.evaluate(() => {
    const viewportWidth = document.documentElement.clientWidth;
    const isInsideHorizontalScroller = (element: HTMLElement): boolean => {
      let ancestor = element.parentElement;

      while (ancestor && ancestor !== document.body) {
        const style = getComputedStyle(ancestor);
        if (
          ["auto", "scroll"].includes(style.overflowX) &&
          ancestor.scrollWidth > ancestor.clientWidth
        ) {
          return true;
        }
        ancestor = ancestor.parentElement;
      }

      return false;
    };

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
        return (
          !isInsideHorizontalScroller(element) &&
          (rect.left < -1 || rect.right > viewportWidth + 1)
        );
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
      ".text-diff-tool__segments span",
      ".text-diff-tool__compare-options label",
      ".regex-tool__flags label",
      ".hash-tool__segments span",
      ".hash-tool__dropzone",
      ".hash-tool label.button",
      ".yaml-json-tool__segments span",
      ".csv-json-tool__segments span",
      ".csv-json-tool__feedback summary",
      ".query-params-tool__segments span",
      ".query-params-tool__feedback summary",
      ".image-compressor-tool__dropzone",
      ".image-compressor-tool__advanced summary",
      ".image-compressor-tool__quality > input[type=range]",
      ".image-compressor-tool__select",
      ".image-compressor-tool__select select",
      ".image-compressor-tool__color",
      ".image-compressor-tool__color input[type=color]",
      ".workflow-studio__privacy a",
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

async function waitForToolHydration(page: Page, toolSlug: string) {
  const workspace = page.locator(`[data-tool-workspace="${toolSlug}"]`);
  await expect(workspace).toBeVisible();

  const island = workspace.locator("xpath=ancestor::astro-island[1]");
  await expect(island).toHaveAttribute("client", "load");
  await expect.poll(() => island.getAttribute("ssr")).toBeNull();
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

    for (const route of [
      "./workflows/new/",
      "./workflows/base64-json-inspect/",
      "./workflows/png-palette-sha256/",
    ] as const) {
      await page.goto(route, { waitUntil: "networkidle" });
      await expect(page.locator("[data-workflow-studio]")).toBeVisible();
      expect(
        await findSmallTouchTargets(page),
        `${route} Studio 触控目标过小`,
      ).toEqual([]);
    }

    await page.goto("./", { waitUntil: "domcontentloaded" });
    await page.getByRole("searchbox", { name: "搜索工具" }).fill("JSON");
    expect(
      await findSmallTouchTargets(page),
      "首页搜索控件触控目标过小",
    ).toEqual([]);

    await page.goto("./privacy/", { waitUntil: "networkidle" });
    await expect(page.locator("[data-privacy-self-test]")).toBeVisible();
    expect(
      await findSmallTouchTargets(page),
      "隐私能力中心触控目标过小",
    ).toEqual([]);
  });

  test("320px 页头四项导航保持同一行且不溢出", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 720 });
    await page.goto("./", { waitUntil: "domcontentloaded" });

    const navigation = page.locator(".main-nav a");
    await expect(navigation).toHaveCount(4);
    const tops = await navigation.evaluateAll((links) =>
      links.map((link) => Math.round(link.getBoundingClientRect().top)),
    );
    expect(new Set(tops).size).toBe(1);
    expect(await findViewportOverflow(page)).toEqual([]);
    expect(await findSmallTouchTargets(page)).toEqual([]);
  });

  test("360px 离线管理面板不溢出且触控目标足够大", async ({ page }) => {
    await page.goto("./", { waitUntil: "domcontentloaded" });
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

    await page
      .locator("[data-pwa-offline-trigger]")
      .filter({ hasText: "离线使用" })
      .first()
      .click();
    const dialog = page.locator("[data-pwa-offline-center]");
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole("button", {
        name: /下载完整离线包|继续下载完整离线包|移除完整离线包/u,
      }),
    ).toBeVisible();

    expect(await findViewportOverflow(page)).toEqual([]);
    expect(await findSmallTouchTargets(page)).toEqual([]);
    const bounds = await dialog.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(361);
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(801);
  });

  test("工具交互后的长结果和错误状态仍不溢出", async ({ page }) => {
    test.setTimeout(90_000);

    await page.goto("./tools/json-formatter/");
    await waitForToolHydration(page, "json-formatter");
    await page.getByLabel("输入").fill(`{"long":"${"中文🙂".repeat(120)}"`);
    await page.getByRole("button", { name: "格式化", exact: true }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await page.getByRole("alert").locator("summary").click();
    expect(await findViewportOverflow(page)).toEqual([]);

    await page.goto("./tools/base64-codec/");
    await waitForToolHydration(page, "base64-codec");
    await page.getByLabel("UTF-8 输入").fill("中文🙂".repeat(300));
    await page.getByRole("button", { name: "编码为 Base64" }).click();
    await expect(page.getByLabel("编码结果")).not.toHaveValue("");
    expect(await findViewportOverflow(page)).toEqual([]);

    await page.goto("./tools/url-codec/");
    await waitForToolHydration(page, "url-codec");
    await page.getByLabel("输入").fill(`%E4%B8${"x".repeat(220)}`);
    await page.getByRole("button", { name: "URL 解码" }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await page.getByRole("alert").locator("summary").click();
    expect(await findViewportOverflow(page)).toEqual([]);

    await page.goto("./tools/unix-timestamp/");
    await waitForToolHydration(page, "unix-timestamp");
    await page
      .getByRole("textbox", { name: "Unix 时间戳", exact: true })
      .fill("0");
    await page.getByRole("button", { name: "转换时间戳" }).click();
    await expect(page.getByLabel("时间戳转换结果")).toBeVisible();
    expect(await findViewportOverflow(page)).toEqual([]);

    await page.goto("./tools/uuid-generator/");
    await waitForToolHydration(page, "uuid-generator");
    await page.getByLabel("生成数量").fill("1000");
    await page.getByRole("button", { name: "生成 UUID" }).click();
    await expect(page.locator(".uuid-tool__list li")).toHaveCount(1000, {
      timeout: 15_000,
    });
    expect(await findViewportOverflow(page)).toEqual([]);
    expect(await findSmallTouchTargets(page)).toEqual([]);

    await page.goto("./tools/image-compressor/", { waitUntil: "networkidle" });
    await waitForToolHydration(page, "image-compressor");
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

    await page.goto("./tools/text-diff/");
    await waitForToolHydration(page, "text-diff");
    await page.getByLabel("原文").fill("第一行\n保留内容\n旧内容");
    await page.getByLabel("新文本").fill("第一行\n保留内容\n新增内容");
    await page.getByRole("button", { name: "开始比较" }).click();
    await expect(
      page.getByRole("table", { name: "统一差异视图" }),
    ).toBeVisible();
    expect(await findViewportOverflow(page)).toEqual([]);
    expect(await findSmallTouchTargets(page)).toEqual([]);

    await page.goto("./tools/regex-tester/");
    await waitForToolHydration(page, "regex-tester");
    await page
      .getByLabel("Pattern", { exact: true })
      .fill(String.raw`(?<word>\p{L}+)`);
    await page
      .getByLabel("测试文本", { exact: true })
      .fill(`移动端 ${"很长的匹配内容".repeat(80)}`);
    await page.getByRole("button", { name: "运行正则测试" }).click();
    await expect(page.locator(".regex-tool__matches > li").first()).toBeVisible(
      {
        timeout: 10_000,
      },
    );
    expect(await findViewportOverflow(page)).toEqual([]);
    expect(await findSmallTouchTargets(page)).toEqual([]);

    await page.goto("./tools/hash-generator/");
    await waitForToolHydration(page, "hash-generator");
    await page.getByLabel("UTF-8 文本").fill("中文🙂".repeat(300));
    await page.getByRole("button", { name: "计算 SHA-256" }).click();
    await expect(page.getByLabel("SHA-256 十六进制摘要")).toHaveValue(
      /^[a-f0-9]{64}$/u,
    );
    expect(await findViewportOverflow(page)).toEqual([]);
    expect(await findSmallTouchTargets(page)).toEqual([]);

    await page.goto("./tools/yaml-json-converter/");
    await waitForToolHydration(page, "yaml-json-converter");
    await page
      .getByLabel("YAML 输入")
      .fill(`message: ${"中文🙂".repeat(120)}\nitems:\n  - one\n  - two`);
    await page.getByRole("button", { name: "转换为 JSON" }).click();
    await expect(page.getByLabel("JSON 输出")).not.toHaveValue("");
    expect(await findViewportOverflow(page)).toEqual([]);
    expect(await findSmallTouchTargets(page)).toEqual([]);

    await page.goto("./tools/jwt-decoder/");
    await waitForToolHydration(page, "jwt-decoder");
    await page.getByRole("button", { name: "载入示例" }).click();
    await page.getByRole("button", { name: "解析 JWT" }).click();
    await expect(
      page.getByLabel("解码后的 JWT Payload", { exact: true }),
    ).toBeVisible();
    expect(await findViewportOverflow(page)).toEqual([]);
    expect(await findSmallTouchTargets(page)).toEqual([]);

    await page.goto("./tools/csv-json-converter/");
    await waitForToolHydration(page, "csv-json-converter");
    await page
      .getByLabel("CSV 输入")
      .fill(`name,notes\nAlice,"${"中文🙂".repeat(120)}"`);
    await page.getByRole("button", { name: "转换为 JSON" }).click();
    await expect(page.getByLabel("JSON 输出")).not.toHaveValue("");
    expect(await findViewportOverflow(page)).toEqual([]);
    expect(await findSmallTouchTargets(page)).toEqual([]);

    await page.goto("./tools/query-params/");
    await waitForToolHydration(page, "query-params");
    await page
      .getByLabel("URL 或查询串输入")
      .fill(`?q=${encodeURIComponent("中文🙂".repeat(120))}&tag=mobile`);
    await page.getByRole("button", { name: "解析查询参数" }).click();
    await expect(page.getByLabel("参数值").first()).not.toHaveValue("");
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
    await expect(page.locator('link[rel="alternate"][hreflang]')).toHaveCount(
      0,
    );
    await expect(
      page.locator(
        'link[rel="alternate"][type="application/json"][title="Privacy manifest"]',
      ),
    ).toHaveAttribute("href", "/online-tools-hub/privacy-manifest.json");
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

  test("指南页提供 Article 与面包屑结构化描述", async ({ page }) => {
    for (const route of guideRoutes) {
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
        expect.arrayContaining(["WebSite", "Article", "BreadcrumbList"]),
      );
      await expect(page.locator('meta[property="og:type"]')).toHaveAttribute(
        "content",
        "article",
      );
      const articleImage = await page
        .locator('script[type="application/ld+json"]')
        .evaluateAll(
          (scripts) =>
            scripts
              .flatMap((script) => {
                const value = JSON.parse(script.textContent ?? "{}") as {
                  "@graph"?: Array<{ "@type"?: string; image?: string }>;
                };
                return value["@graph"] ?? [];
              })
              .find((node) => node["@type"] === "Article")?.image,
        );
      expect(articleImage).toMatch(/\/online-tools-hub\/og-image\.png$/u);
      await expect(page.locator(".guide-prose section")).toHaveCount(3);
    }
  });

  test("工作流页提供 Collection、SoftwareApplication、HowTo 与面包屑结构化描述", async ({
    page,
  }) => {
    await page.goto("./workflows/", { waitUntil: "domcontentloaded" });
    const collectionTypes = await page
      .locator('script[type="application/ld+json"]')
      .evaluateAll((scripts) =>
        scripts.flatMap((script) => {
          const value = JSON.parse(script.textContent ?? "{}") as {
            "@graph"?: Array<{ "@type"?: string }>;
          };
          return (value["@graph"] ?? []).map((node) => node["@type"]);
        }),
      );
    expect(collectionTypes).toEqual(
      expect.arrayContaining(["WebSite", "CollectionPage", "ItemList"]),
    );

    for (const route of workflowRoutes) {
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
          "SoftwareApplication",
          "HowTo",
          "BreadcrumbList",
        ]),
      );
    }
  });
});

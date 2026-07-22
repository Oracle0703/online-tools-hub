import { readFile } from "node:fs/promises";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";

const fixtureDirectory = path.resolve("tests/fixtures/qr-code");
const unicodeText = "二维码识别 fixture · Unicode 👋";
const unsafeText =
  "javascript:alert(1)\nhttps://canary.invalid/qr?secret=local-only";

async function openScanMode(page: Page) {
  await page.goto("./tools/qr-code/", { waitUntil: "networkidle" });
  await page.getByRole("radio", { name: /识别图片/u }).check();
  await expect(page.locator('[data-qr-mode="scan"]')).toBeVisible();
}

async function chooseAndScan(page: Page, name: string) {
  await page
    .locator(".qr-tool__file-input")
    .setInputFiles(path.join(fixtureDirectory, name));
  await expect(page.locator("[data-qr-status]")).toContainText(
    "图片头部已验证",
  );
  await page.getByRole("button", { name: "识别二维码" }).click();
}

test("生成 Unicode 二维码并下载无源文本的固定 SVG", async ({ page }) => {
  const privateText = "二维码本地生成 · 私密内容 👋";
  await page.goto("./tools/qr-code/", { waitUntil: "networkidle" });
  await page.getByLabel("要编码的文本").fill(privateText);
  await page.getByRole("radio", { name: /Q · 25%/u }).check();
  await page.getByLabel("下载显示尺寸").selectOption("1024");
  await page.getByRole("button", { name: "生成二维码" }).click();

  await expect(page.locator("[data-qr-preview] img")).toHaveAttribute(
    "src",
    /^blob:/u,
  );
  await expect(page.locator("[data-qr-status]")).toContainText("二维码已生成");
  await expect(page.locator("[data-qr-preview]")).toContainText("Q 级纠错");

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载 SVG" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("qr-code.svg");
  const downloadPath = await download.path();
  expect(downloadPath).not.toBeNull();
  const svg = await readFile(downloadPath!, "utf8");
  expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/u);
  expect(svg).toContain('<rect width="');
  expect(svg).toContain('<path d="');
  expect(svg).not.toContain(privateText);
  expect(svg).not.toMatch(
    /<(?:script|style|image|a|text|title|desc|metadata)\b/iu,
  );
  expect(svg).not.toMatch(/(?:href|onload|url\()/iu);

  await page.getByLabel("下载显示尺寸").selectOption("512");
  await expect(page.locator("[data-qr-preview]")).toHaveCount(0);
  await expect(page.locator("[data-qr-status]")).toContainText(
    "旧预览已清除，请重新生成",
  );
});

test("识别已提交的 PNG、旋转 JPEG、反色 WebP 与低清图片", async ({ page }) => {
  await openScanMode(page);
  for (const name of [
    "unicode.png",
    "rotated.jpg",
    "inverted.webp",
    "low-resolution.png",
  ]) {
    await chooseAndScan(page, name);
    const result = page.locator("[data-qr-scan-result]");
    await expect(result).toHaveValue(unicodeText);
    await expect(page.locator("[data-qr-status]")).toContainText("识别完成");
    await page.getByRole("button", { name: "清空" }).click();
  }
});

test("动画 WebP 与超过源像素预算的真实图片在解码前拒绝", async ({ page }) => {
  await openScanMode(page);
  const input = page.locator(".qr-tool__file-input");
  const execute = page.getByRole("button", { name: "识别二维码" });

  await input.setInputFiles(path.join(fixtureDirectory, "animated.webp"));
  await expect(page.locator("[data-qr-status]")).toContainText(
    "不识别动画 WebP",
  );
  await expect(execute).toBeDisabled();

  await input.setInputFiles(path.join(fixtureDirectory, "over-limit.png"));
  await expect(page.locator("[data-qr-status]")).toContainText(
    "图片超过 16 MP",
  );
  await expect(execute).toBeDisabled();
});

test("网址样式结果保持纯文本且不导航或请求", async ({ page }) => {
  const externalRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("canary.invalid")) {
      externalRequests.push(request.url());
    }
  });
  await openScanMode(page);
  const initialUrl = page.url();
  await chooseAndScan(page, "unsafe-url.png");

  const result = page.locator("[data-qr-scan-result]");
  await expect(result).toHaveValue(unsafeText);
  await expect(page).toHaveURL(initialUrl);
  await expect(page.locator('a[href*="canary.invalid"]')).toHaveCount(0);
  await expect(page.locator('a[href^="javascript:"]')).toHaveCount(0);
  expect(externalRequests).toEqual([]);

  await page.getByLabel("同时尝试反色二维码").uncheck();
  await expect(page.locator("[data-qr-scan-result]")).toHaveCount(0);
  await expect(page.locator("[data-qr-status]")).toContainText(
    "旧结果已清除，请重新识别",
  );
});

test("损坏、非支持格式与无码图片都安全失败", async ({ page }) => {
  await openScanMode(page);
  await page
    .locator(".qr-tool__file-input")
    .setInputFiles(path.join(fixtureDirectory, "corrupt.png"));
  await expect(page.locator("[data-qr-status]")).toContainText(
    "图片容器损坏或不完整",
  );

  await page.locator(".qr-tool__file-input").setInputFiles({
    name: "not-an-image.svg",
    mimeType: "image/svg+xml",
    buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
  });
  await expect(page.locator("[data-qr-status]")).toContainText(
    "只支持有效的 JPEG、PNG 或 WebP",
  );

  await chooseAndScan(page, "no-qr.png");
  await expect(page.locator("[data-qr-status]")).toContainText(
    "没有识别到二维码",
  );
  await expect(page.locator("[data-qr-scan-result]")).toHaveCount(0);
});

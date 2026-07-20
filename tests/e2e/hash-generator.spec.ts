import { Buffer } from "node:buffer";

import { expect, test, type Download } from "@playwright/test";

async function downloadText(download: Download): Promise<string> {
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

test.describe("SHA-256 / SHA-512 哈希计算", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("./tools/hash-generator/", { waitUntil: "networkidle" });
  });

  test("按 UTF-8 计算 SHA-256 并通过键盘快捷键执行", async ({ page }) => {
    const input = page.getByRole("textbox", {
      name: "UTF-8 文本",
      exact: true,
    });
    await input.fill("abc");
    await input.press("ControlOrMeta+Enter");

    await expect(page.getByLabel("SHA-256 十六进制摘要")).toHaveValue(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    await expect(page.getByRole("status")).toContainText(
      "SHA-256 摘要计算完成",
    );
  });

  test("切换 SHA-512，并用大写期望值核对摘要", async ({ page }) => {
    await page
      .getByRole("group", { name: "算法" })
      .getByText("SHA-512", { exact: true })
      .click();
    await page
      .getByRole("textbox", { name: "UTF-8 文本", exact: true })
      .fill("abc");
    await page.getByRole("button", { name: "计算 SHA-512" }).click();

    const expected =
      "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f";
    await expect(page.getByLabel("SHA-512 十六进制摘要")).toHaveValue(expected);
    await page.getByLabel("期望摘要").fill(expected.toUpperCase());
    await page.getByRole("button", { name: "比较摘要" }).click();
    await expect(page.locator(".hash-tool__compare-result")).toContainText(
      "摘要一致",
    );
  });

  test("本地文件使用同一套摘要引擎且可下载纯文本结果", async ({ page }) => {
    await page
      .getByRole("group", { name: "输入来源" })
      .getByText("本地文件", { exact: true })
      .click();
    await page.getByLabel("选择本地文件").setInputFiles({
      name: "local-only.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("abc", "utf8"),
    });
    await expect(page.locator(".hash-tool__dropzone")).toContainText(
      "local-only.txt",
    );
    await page.getByRole("button", { name: "计算 SHA-256" }).click();

    const expected =
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
    await expect(page.getByLabel("SHA-256 十六进制摘要")).toHaveValue(expected);

    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "下载 .txt" }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("sha-256-digest.txt");
    await expect(downloadText(download)).resolves.toBe(`${expected}\n`);
  });

  test("移动端不会产生水平滚动，核心操作保持可见", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.reload({ waitUntil: "networkidle" });

    await expect(
      page.getByRole("button", { name: "计算 SHA-256" }),
    ).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });
});

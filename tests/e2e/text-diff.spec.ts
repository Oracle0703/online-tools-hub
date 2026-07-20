import { Buffer } from "node:buffer";

import { expect, test, type Download, type Page } from "@playwright/test";

async function downloadText(download: Download): Promise<string> {
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function selectDiffView(
  page: Page,
  name: "统一视图" | "并排视图",
): Promise<void> {
  const option = page
    .locator(".text-diff-tool__segments label")
    .filter({ hasText: name });

  await option.click();
  await expect(option.getByRole("radio")).toBeChecked();
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          (
            globalThis as typeof globalThis & { __copiedDiff?: string }
          ).__copiedDiff = value;
        },
      },
    });
  });

  await page.goto("./tools/text-diff/", { waitUntil: "networkidle" });
});

test("示例生成统一差异并可切换为并排视图", async ({ page }) => {
  await page.getByRole("button", { name: "载入示例" }).click();
  await expect(page.getByLabel("原文")).toHaveValue(/theme: "light"/u);
  await expect(page.getByLabel("新文本")).toHaveValue(/cache: true/u);

  await page.getByRole("button", { name: "开始比较" }).click();
  await expect(page.getByRole("status")).toContainText("发现 1 个差异块");

  const unified = page.getByRole("table", { name: "统一差异视图" });
  await expect(unified).toBeVisible();
  await expect(unified).toContainText('theme: "light"');
  await expect(unified).toContainText('theme: "dark"');
  await expect(page.getByLabel("差异统计")).toContainText("4 新增");
  await expect(page.getByLabel("差异统计")).toContainText("3 删除");

  await selectDiffView(page, "并排视图");
  const split = page.getByRole("table", { name: "并排差异视图" });
  await expect(split).toBeVisible();
  await expect(
    split.getByRole("row", { name: "修改行" }).first(),
  ).toContainText('theme: "light"');
  await expect(
    split.getByRole("row", { name: "修改行" }).first(),
  ).toContainText('theme: "dark"');
});

test("忽略空白和大小写后通过键盘快捷键判定一致", async ({ page }) => {
  const original = page.getByLabel("原文");
  await original.fill("Hello   World\nVALUE = 1");
  await page.getByLabel("新文本").fill("hello world\nvalue=1");
  await page.getByRole("checkbox", { name: "忽略空白" }).check();
  await page.getByRole("checkbox", { name: "忽略大小写" }).check();
  await original.press("ControlOrMeta+Enter");

  await expect(page.getByRole("status")).toContainText("两侧内容一致");
  await expect(page.getByRole("heading", { name: "内容一致" })).toBeVisible();
  await expect(page.getByLabel("差异统计")).toContainText("0 新增");
  await expect(page.getByLabel("差异统计")).toContainText("0 删除");
});

test("统一差异可以复制并下载为 diff 文件", async ({ page }) => {
  await page.getByLabel("原文").fill("keep\nold");
  await page.getByLabel("新文本").fill("keep\nnew");
  await page.getByRole("button", { name: "开始比较" }).click();

  await page.getByRole("button", { name: "复制差异" }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (globalThis as typeof globalThis & { __copiedDiff?: string })
            .__copiedDiff,
      ),
    )
    .toBe(
      [
        "--- 原文",
        "+++ 新文本",
        "@@ -1,2 +1,2 @@",
        " keep",
        "-old",
        "+new",
      ].join("\n"),
    );

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载 .diff" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("text-changes.diff");
  await expect(downloadText(download)).resolves.toContain("-old\n+new");
});

test("行数上限明确，移动端不会产生页面级水平滚动", async ({ page }) => {
  await page.getByLabel("原文").evaluate((element, lineBreakCount) => {
    const textarea = element as HTMLTextAreaElement;
    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    const value = `${"line\n".repeat(lineBreakCount)}last`;

    if (valueSetter) valueSetter.call(textarea, value);
    else textarea.value = value;

    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  }, 5_000);
  await expect(page.getByRole("alert")).toContainText(
    "5,001 行，超过每侧 5,000 行上限",
  );
  await expect(page.getByRole("button", { name: "开始比较" })).toBeDisabled();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("button", { name: "载入示例" }).click();
  await page.getByRole("button", { name: "开始比较" }).click();
  await selectDiffView(page, "并排视图");

  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(
    dimensions.clientWidth + 1,
  );

  for (const name of ["开始比较", "交换两侧", "复制差异"]) {
    const box = await page.getByRole("button", { name }).boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(44);
  }
});

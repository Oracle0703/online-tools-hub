import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          (
            globalThis as typeof globalThis & { __copiedText?: string }
          ).__copiedText = value;
        },
      },
    });
  });

  await page.goto("./tools/query-params/", { waitUntil: "networkidle" });
});

test("完整 URL 示例保留重复键、空值和无等号项，并可复制下载", async ({
  page,
}) => {
  await page.getByRole("button", { name: "载入示例" }).click();
  const input = page.getByLabel("URL 或查询串输入");
  await expect(input).toHaveValue(/tag=web&tag=local&empty=&preview/u);

  await page.getByRole("button", { name: "解析查询参数" }).click();
  await expect(page.getByRole("status")).toContainText("已解析 5 项参数");
  await expect(page.getByLabel("解析摘要")).toContainText("1 个重复键");
  await expect(page.getByLabel("解析摘要")).toContainText("1 项无等号");
  await expect(page.locator(".query-params-tool__parameter")).toHaveCount(5);

  const output = page.getByRole("textbox", { name: "原始形式" });
  await expect(output).toHaveValue(
    "https://example.com/search?q=%E4%B8%AD%E6%96%87+tools&tag=web&tag=local&empty=&preview#results",
  );

  await page.getByRole("button", { name: "复制结果" }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (globalThis as typeof globalThis & { __copiedText?: string })
            .__copiedText,
      ),
    )
    .toContain("tag=web&tag=local");

  const textDownloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载 .txt" }).click();
  expect((await textDownloadPromise).suggestedFilename()).toBe(
    "rebuilt-query.txt",
  );

  const jsonDownloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出 JSON" }).click();
  expect((await jsonDownloadPromise).suggestedFilename()).toBe(
    "query-parameters.json",
  );
});

test("结构化增删和显式稳定排序会同步重建查询串", async ({ page }) => {
  await page
    .getByLabel("URL 或查询串输入")
    .fill("?z=9&a=1&a=2&empty=&flag&&=value");
  await page.getByRole("button", { name: "解析查询参数" }).click();

  await expect(page.getByRole("textbox", { name: "原始形式" })).toHaveValue(
    "?z=9&a=1&a=2&empty=&flag&&=value",
  );

  await page.getByRole("button", { name: "删除参数 5" }).click();
  await expect(page.getByLabel("参数名").nth(4)).toBeFocused();
  await expect(page.getByRole("textbox", { name: "原始形式" })).toHaveValue(
    "?z=9&a=1&a=2&empty=&&=value",
  );

  await page.getByRole("button", { name: "新增参数" }).click();
  const names = page.getByLabel("参数名");
  const values = page.getByLabel("参数值");
  await names.last().fill("new key");
  await values.last().fill("a+b");
  await expect(page.getByRole("textbox", { name: "原始形式" })).toHaveValue(
    "?z=9&a=1&a=2&empty=&&=value&new+key=a%2Bb",
  );

  await page.getByRole("button", { name: "按参数名排序" }).click();
  await expect(page.getByRole("textbox", { name: "原始形式" })).toHaveValue(
    "?&=value&a=1&a=2&empty=&new+key=a%2Bb&z=9",
  );
  await expect(page.getByRole("status")).toContainText("稳定排序");

  await page.getByText("仅 ?query", { exact: true }).click();
  await expect(page.getByRole("textbox", { name: "仅 ? 查询串" })).toHaveValue(
    "?&=value&a=1&a=2&empty=&new+key=a%2Bb&z=9",
  );
});

test("表单和 RFC 模式对加号采用明确且不同的语义", async ({ page }) => {
  const input = page.getByLabel("URL 或查询串输入");
  await input.fill("?q=a+b&literal=a%2Bb");
  await page.getByRole("button", { name: "解析查询参数" }).click();

  await expect(page.getByLabel("参数值").nth(0)).toHaveValue("a b");
  await expect(page.getByLabel("参数值").nth(1)).toHaveValue("a+b");

  await page.getByText("RFC 百分号", { exact: true }).click();
  await page.getByRole("button", { name: "解析查询参数" }).click();
  await expect(page.getByLabel("参数值").nth(0)).toHaveValue("a+b");
  await expect(page.getByLabel("参数值").nth(1)).toHaveValue("a+b");
  await expect(page.getByRole("textbox", { name: "原始形式" })).toHaveValue(
    "?q=a%2Bb&literal=a%2Bb",
  );
});

test("严格定位非法百分号转义并支持键盘解析", async ({ page }) => {
  const input = page.getByLabel("URL 或查询串输入");
  await input.fill("https://x.test/path?ok=1&bad=%GG");
  await input.press("Control+Enter");

  const alert = page.getByRole("alert");
  await expect(alert).toContainText("参数 2");
  await expect(input).toBeFocused();
  await expect
    .poll(() =>
      input.evaluate(
        (element) => (element as HTMLTextAreaElement).selectionStart,
      ),
    )
    .toBe(29);
  await alert.locator("summary").click();
  await expect(alert).toContainText("% 后必须紧跟两个十六进制字符");
});

test("编辑产生无法编码的 Unicode 时明确报告重建错误", async ({ page }) => {
  await page.getByLabel("URL 或查询串输入").fill("?name=safe");
  await page.getByRole("button", { name: "解析查询参数" }).click();

  await page.getByLabel("参数名").evaluate((element) => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    setter?.call(element, "\ud800");
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });

  await expect(page.getByRole("alert")).toContainText("无法重建参数 1");
  await page.getByRole("button", { name: "复制结果" }).click();
  await expect(page.getByRole("alert").last()).toContainText(
    "未配对的 Unicode 代理字符",
  );
});

test("可从空查询串构建空键、空值和无等号参数", async ({ page }) => {
  await page.getByRole("button", { name: "从空查询串开始" }).click();
  await expect(page.getByRole("textbox", { name: "原始形式" })).toHaveValue(
    "?=",
  );

  await page.getByLabel("参数 1 的等号形式").selectOption("bare");
  await expect(page.getByRole("textbox", { name: "原始形式" })).toHaveValue(
    "?",
  );

  await page.getByRole("button", { name: "新增参数" }).click();
  await page.getByLabel("参数名").nth(1).fill("empty");
  await expect(page.getByRole("textbox", { name: "原始形式" })).toHaveValue(
    "?&empty=",
  );
});

test("移动端保持单列、无水平溢出且关键按钮满足触控尺寸", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "载入示例" }).click();
  await page.getByRole("button", { name: "解析查询参数" }).click();

  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(
    dimensions.clientWidth + 1,
  );

  for (const name of ["新增参数", "按参数名排序", "复制结果", "导出 JSON"]) {
    const box = await page.getByRole("button", { name }).boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(44);
  }
});

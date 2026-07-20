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

  await page.goto("./tools/csv-json-converter/", {
    waitUntil: "networkidle",
  });
});

test("CSV 示例可安全识别、保留字符串、复制并下载 JSON", async ({ page }) => {
  await page.getByRole("button", { name: "载入示例" }).click();
  await expect(page.getByLabel("CSV 输入")).toHaveValue(/保留前导零/u);

  await page.getByRole("button", { name: "转换为 JSON" }).click();
  const output = page.getByLabel("JSON 输出");
  await expect(output).toHaveValue(/"id": "001"/u);
  await expect(output).toHaveValue(/"note": "第一行\\n第二行"/u);
  await expect(page.getByRole("status")).toContainText("3 行 × 4 列");
  await expect(page.getByRole("status")).toContainText("使用逗号");

  await page.getByRole("button", { name: "复制结果" }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (globalThis as typeof globalThis & { __copiedText?: string })
            .__copiedText,
      ),
    )
    .toContain('"id": "001"');

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载 .json" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("converted.json");
});

test("JSON 可用分号转为 CSV，交换时同步方向和分隔符", async ({ page }) => {
  await page.getByText("JSON → CSV", { exact: true }).click();
  await page.getByLabel("CSV 分隔符").selectOption(";");
  const source =
    '[{"id":"001","name":"小明","active":true},{"id":"002","name":"小红","active":false}]';
  await page.getByLabel("JSON 输入").fill(source);
  await page.getByRole("button", { name: "转换为 CSV" }).click();

  const csvOutput = page.getByLabel("CSV 输出");
  await expect(csvOutput).toHaveValue(
    /id;name;active\r?\n001;小明;true\r?\n002;小红;false/u,
  );

  const csvValue = await csvOutput.inputValue();
  await page.getByRole("button", { name: "交换输入输出" }).click();
  await expect(page.getByLabel("CSV 输入")).toHaveValue(csvValue);
  await expect(page.getByLabel("JSON 输出")).toHaveValue(source);
  await expect(page.getByLabel("CSV 分隔符")).toHaveValue(";");
  await expect(page.getByRole("button", { name: "转换为 JSON" })).toBeEnabled();
});

test("歧义分隔符、重复表头和列数不一致均给出明确错误", async ({ page }) => {
  await page.getByLabel("CSV 输入").fill("left,right;note\n1,2;ok");
  await page.getByRole("button", { name: "转换为 JSON" }).click();
  let alert = page.getByRole("alert");
  await expect(alert).toContainText("第 1 行，第 1 列");
  await alert.locator("summary").click();
  await expect(alert).toContainText("多个可能的分隔符");

  await page.getByLabel("CSV 分隔符").selectOption(",");
  await page.getByLabel("CSV 输入").fill("name,name\n小明,上海");
  await page.getByRole("button", { name: "转换为 JSON" }).click();
  alert = page.getByRole("alert");
  await alert.locator("summary").click();
  await expect(alert).toContainText("表头“name”重复");

  await page.getByLabel("CSV 输入").fill("name,city\n小明");
  await page.getByRole("button", { name: "转换为 JSON" }).click();
  alert = page.getByRole("alert");
  await alert.locator("summary").click();
  await expect(alert).toContainText("有 1 列，但表头有 2 列");
});

test("JSON 转 CSV 拒绝不安全数字和嵌套单元格", async ({ page }) => {
  await page.getByText("JSON → CSV", { exact: true }).click();
  await page
    .getByLabel("JSON 输入")
    .fill('[{"id":"001","value":9007199254740993}]');
  await page.getByRole("button", { name: "转换为 CSV" }).click();

  let alert = page.getByRole("alert");
  await alert.locator("summary").click();
  await expect(alert).toContainText("避免精度丢失");

  await page
    .getByLabel("JSON 输入")
    .fill('[{"id":"001","meta":{"city":"上海"}}]');
  await page.getByRole("button", { name: "转换为 CSV" }).click();
  alert = page.getByRole("alert");
  await alert.locator("summary").click();
  await expect(alert).toContainText("嵌套对象或数组");
});

test("移动端保持单列、没有水平溢出且核心操作达到触控尺寸", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("button", { name: "载入示例" }).click();
  await page.getByRole("button", { name: "转换为 JSON" }).click();

  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(
    dimensions.clientWidth + 1,
  );

  for (const name of ["转换为 JSON", "交换输入输出", "复制结果"]) {
    const box = await page.getByRole("button", { name }).boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(44);
  }
});

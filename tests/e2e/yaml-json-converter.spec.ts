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

  await page.goto("./tools/yaml-json-converter/", {
    waitUntil: "networkidle",
  });
});

test("YAML 示例可转换、复制并下载为 JSON", async ({ page }) => {
  await page.getByRole("button", { name: "载入示例" }).click();
  await expect(page.getByLabel("YAML 输入")).toHaveValue(/支持中文/u);

  await page.getByRole("button", { name: "转换为 JSON" }).click();
  const output = page.getByLabel("JSON 输出");
  await expect(output).toHaveValue(/"features": \[/u);
  await expect(output).toHaveValue(/"小明"/u);
  await expect(page.getByRole("status")).toContainText("已转换为 JSON");

  await page.getByRole("button", { name: "复制结果" }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (globalThis as typeof globalThis & { __copiedText?: string })
            .__copiedText,
      ),
    )
    .toContain('"project": "Online Tools Hub"');

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载 .json" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("converted.json");
});

test("JSON 可转为 YAML，交换时同步切换方向", async ({ page }) => {
  await page.getByText("JSON → YAML", { exact: true }).click();
  const source = '{"name":"在线工具箱","items":["中文","数组"]}';
  await page.getByLabel("JSON 输入").fill(source);
  await page.getByRole("button", { name: "转换为 YAML" }).click();

  const yamlOutput = page.getByLabel("YAML 输出");
  await expect(yamlOutput).toHaveValue(/name: 在线工具箱/u);
  await expect(yamlOutput).toHaveValue(/ {2}- 中文/u);

  const yamlValue = await yamlOutput.inputValue();
  await page.getByRole("button", { name: "交换输入输出" }).click();
  await expect(page.getByLabel("YAML 输入")).toHaveValue(yamlValue);
  await expect(page.getByLabel("JSON 输出")).toHaveValue(source);
  await expect(page.getByRole("button", { name: "转换为 JSON" })).toBeEnabled();
});

test("多文档和语法错误显示明确边界及行列", async ({ page }) => {
  await page.getByLabel("YAML 输入").fill("name: first\n---\nname: second");
  await page.getByRole("button", { name: "转换为 JSON" }).click();

  let alert = page.getByRole("alert");
  await expect(alert).toContainText("第 2 行，第 1 列");
  await alert.locator("summary").click();
  await expect(alert).toContainText("仅支持单个 YAML 文档");

  await page.getByLabel("YAML 输入").fill("project: ok\nitems:\n  - [one, two");
  await page.getByRole("button", { name: "转换为 JSON" }).click();
  alert = page.getByRole("alert");
  await expect(alert).toContainText("第 3 行");
});

test("双向转换会拒绝可能静默舍入的数字", async ({ page }) => {
  await page
    .getByLabel("YAML 输入")
    .fill("safe: true\nvalue: 1.0000000000000001");
  await page.getByRole("button", { name: "转换为 JSON" }).click();

  let alert = page.getByRole("alert");
  await expect(alert).toContainText("第 2 行，第 8 列");
  await alert.locator("summary").click();
  await expect(alert).toContainText("保持原值");

  await page.getByText("JSON → YAML", { exact: true }).click();
  await page.getByLabel("JSON 输入").fill('{"value":9007199254740993e0}');
  await page.getByRole("button", { name: "转换为 YAML" }).click();

  alert = page.getByRole("alert");
  await expect(alert).toContainText("第 1 行，第 10 列");
  await alert.locator("summary").click();
  await expect(alert).toContainText("保持原值");
});

test("移动端保持单列且没有水平溢出", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
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

import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("./tools/json-formatter/", {
    waitUntil: "networkidle",
  });
});

test("格式化时保留安全整数范围外的数字", async ({ page }) => {
  const input = page.getByLabel("输入");
  const output = page.getByLabel("输出");
  const largeInteger = "90071992547409931234567890";

  await input.fill(`{"large":${largeInteger},"message":"中文🙂"}`);
  await page.getByText("4 空格", { exact: true }).click();
  await page.getByRole("button", { name: "格式化", exact: true }).click();

  await expect(output).toHaveValue(
    `{
    "large": ${largeInteger},
    "message": "中文🙂"
}`,
  );
  await expect(page.getByRole("status")).toContainText("格式化完成");
});

test("无效 JSON 显示行列和附近上下文", async ({ page }) => {
  await page.getByLabel("输入").fill(`{
  "valid": true,
  "broken": nope
}`);
  await page.getByRole("button", { name: "格式化", exact: true }).click();

  const alert = page.getByRole("alert");
  await expect(alert).toContainText("第 3 行，第 14 列");
  await alert.locator("summary").click();
  await expect(alert.locator("pre")).toContainText('"broken": nope');
});

test("示例、压缩和清空组成完整本地流程", async ({ page }) => {
  const input = page.getByLabel("输入");
  const output = page.getByLabel("输出");

  await page.getByRole("button", { name: "载入示例" }).click();
  await expect(input).toHaveValue(/Online Tools Hub/u);
  await page.getByRole("button", { name: "压缩" }).click();
  await expect(output).toHaveValue(/^\{"project":"Online Tools Hub"/u);

  await page.getByRole("button", { name: "清空" }).click();
  await expect(input).toHaveValue("");
  await expect(output).toHaveValue("");
});

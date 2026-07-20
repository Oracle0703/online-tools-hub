import { expect, test } from "@playwright/test";

test.describe("Base64 编解码", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("./tools/base64-codec/", {
      waitUntil: "networkidle",
    });
  });

  test("将中文与 Emoji 按 UTF-8 编码为标准 Base64", async ({ page }) => {
    await page.getByLabel("UTF-8 输入").fill("中文🙂");
    await page.getByRole("button", { name: "编码为 Base64" }).click();

    await expect(page.getByLabel("编码结果")).toHaveValue("5Lit5paH8J+Zgg==");
    await expect(page.getByRole("status")).toContainText("编码完成");
  });

  test("严格拒绝不属于标准 Base64 字母表的字符", async ({ page }) => {
    const operationGroup = page.getByRole("group", { name: "操作" });
    await operationGroup.getByText("解码", { exact: true }).click();
    await page.getByLabel("Base64 输入").fill("SGVsbG8*");
    await page.getByRole("button", { name: "解码 Base64" }).click();

    await expect(page.getByRole("alert")).toContainText(
      "不属于标准 Base64 字母表",
    );
    await expect(page.getByLabel("UTF-8 结果")).toHaveValue("");
  });

  test("Base64URL 支持无填充编码并可交换后解码", async ({ page }) => {
    const formatGroup = page.getByRole("group", { name: "格式" });

    await formatGroup.getByText("Base64URL", { exact: true }).click();
    await page.getByLabel("UTF-8 输入").fill("???");
    await page.getByRole("button", { name: "编码为 Base64URL" }).click();
    await expect(page.getByLabel("编码结果")).toHaveValue("Pz8_");

    await page.getByRole("button", { name: "交换" }).click();
    await expect(page.getByLabel("Base64 输入")).toHaveValue("Pz8_");
    await page.getByRole("button", { name: "解码 Base64URL" }).click();
    await expect(page.getByLabel("UTF-8 结果")).toHaveValue("???");
  });
});

test.describe("URL 编解码", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("./tools/url-codec/", {
      waitUntil: "networkidle",
    });
  });

  test("完整 URL 的查询参数支持表单空格规则且不会跳转", async ({ page }) => {
    const originalPageUrl = page.url();
    const scopeGroup = page.getByRole("group", { name: "处理范围" });

    await scopeGroup.getByText("完整 URL", { exact: true }).click();
    await page.getByRole("checkbox", { name: "表单规则（空格 ↔ +）" }).check();
    await page
      .getByLabel("输入")
      .fill("https://example.com/a b?q=中文 c+d#片段");
    await page.getByRole("button", { name: "URL 编码" }).click();

    await expect(page.getByLabel("输出")).toHaveValue(
      "https://example.com/a%20b?q=%E4%B8%AD%E6%96%87+c%2Bd#%E7%89%87%E6%AE%B5",
    );
    await expect(page.getByRole("status")).toContainText(
      "未打开或请求输入地址",
    );
    expect(page.url()).toBe(originalPageUrl);
  });

  test("解码时报告不完整 UTF-8 百分号序列", async ({ page }) => {
    await page.getByLabel("输入").fill("%E4%B8");
    await page.getByRole("button", { name: "URL 解码" }).click();

    const alert = page.getByRole("alert");
    await expect(alert).toContainText("第 1 行，第 1 列");
    await alert.locator("summary").click();
    await expect(alert).toContainText("不是有效的 UTF-8 序列");
    await expect(page.getByLabel("输出")).toHaveValue("");
  });

  test("完整 URL 编码保留 IPv6 主机括号", async ({ page }) => {
    const scopeGroup = page.getByRole("group", { name: "处理范围" });

    await scopeGroup.getByText("完整 URL", { exact: true }).click();
    await page.getByLabel("输入").fill("https://[2001:db8::1]/a b");
    await page.getByRole("button", { name: "URL 编码" }).click();

    await expect(page.getByLabel("输出")).toHaveValue(
      "https://[2001:db8::1]/a%20b",
    );
  });
});

test.describe("Unix 时间戳转换", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("./tools/unix-timestamp/", {
      waitUntil: "networkidle",
    });
  });

  test("零秒时间戳得到固定的 UTC 与 ISO 8601 结果", async ({ page }) => {
    const timestampInput = page.getByRole("textbox", {
      name: "Unix 时间戳",
      exact: true,
    });
    await timestampInput.fill("0");
    await page.getByRole("button", { name: "转换时间戳" }).click();

    const results = page.getByLabel("时间戳转换结果");
    await expect(results).toContainText("Thu, 01 Jan 1970 00:00:00 GMT");
    await expect(results).toContainText("1970-01-01T00:00:00.000Z");
    await expect(page.getByRole("status")).toContainText("输入按秒处理");
  });

  test("拒绝超过 JavaScript Date 范围的时间戳", async ({ page }) => {
    const timestampInput = page.getByRole("textbox", {
      name: "Unix 时间戳",
      exact: true,
    });
    await timestampInput.fill("8640000000000001");
    await page.getByRole("button", { name: "转换时间戳" }).click();

    await expect(page.getByRole("alert")).toContainText(
      "时间戳超出 JavaScript Date 可表示的范围",
    );
    await expect(timestampInput).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByLabel("时间戳转换结果")).toHaveCount(0);
  });

  test("把 UTC 日期反向转换为负数 Unix 时间戳", async ({ page }) => {
    await page
      .getByLabel("日期与时间", { exact: true })
      .fill("1969-12-31T23:59:59");
    await page
      .getByRole("group", { name: "将输入解释为" })
      .getByText("UTC", { exact: true })
      .click();
    await page.getByRole("button", { name: "生成时间戳" }).click();

    const results = page.getByLabel("日期转换结果");
    await expect(results).toContainText("-1");
    await expect(results).toContainText("-1000");
    await expect(results).toContainText("1969-12-31T23:59:59.000Z");
  });
});

test.describe("UUID v4 生成", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("./tools/uuid-generator/", {
      waitUntil: "networkidle",
    });
  });

  test("批量生成格式正确且互不重复的 UUID v4", async ({ page }) => {
    await page.getByLabel("生成数量").fill("5");
    await page.getByRole("button", { name: "生成 UUID" }).click();

    await expect(page.getByRole("status")).toContainText("已生成 5 个");
    const results = page.getByRole("region", { name: "5 个 UUID v4" });
    await expect(results).toBeVisible();

    const values = await results
      .getByRole("listitem")
      .locator("code")
      .allTextContents();
    expect(values).toHaveLength(5);
    expect(new Set(values).size).toBe(5);
    for (const value of values) {
      expect(value).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      );
    }
  });

  test("数量超过 1000 时阻止生成", async ({ page }) => {
    const count = page.getByLabel("生成数量");
    const generate = page.getByRole("button", { name: "生成 UUID" });

    await count.fill("1001");

    await expect(count).toHaveAttribute("aria-invalid", "true");
    await expect(generate).toBeDisabled();
    const results = page.getByRole("region", { name: "等待生成" });
    await expect(results).toBeVisible();
    await expect(results.getByRole("list")).toHaveCount(0);
  });
});

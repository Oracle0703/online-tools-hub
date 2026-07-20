import { Buffer } from "node:buffer";

import { expect, test, type Download } from "@playwright/test";

function encodePart(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function tokenFor(payload: Record<string, unknown>): string {
  return `${encodePart({ alg: "HS256", typ: "JWT" })}.${encodePart(payload)}.c2ln`;
}

function tokenFromJson(payloadJson: string): string {
  const header = encodePart({ alg: "HS256", typ: "JWT" });
  const payload = Buffer.from(payloadJson, "utf8").toString("base64url");
  return `${header}.${payload}.c2ln`;
}

async function downloadText(download: Download): Promise<string> {
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

test.describe("JWT 本地解析", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("./tools/jwt-decoder/", { waitUntil: "networkidle" });
  });

  test("解析示例 Header、Payload 与时间声明但不宣称验签", async ({ page }) => {
    await page.getByRole("button", { name: "载入示例" }).click();
    await page.getByLabel("JWT Token").press("ControlOrMeta+Enter");

    await expect(
      page.getByLabel("解码后的 JWT Header", { exact: true }),
    ).toContainText('"alg": "HS256"');
    await expect(
      page.getByLabel("解码后的 JWT Payload", { exact: true }),
    ).toContainText('"sub": "online-tools-demo"');
    await expect(page.getByRole("status")).toContainText("尚未使用密钥验证");
    await expect(page.getByLabel("解析结果可信度")).toContainText(
      "不代表令牌有效、可信或仍有权限",
    );
    await expect(
      page.getByRole("heading", { name: "常见 NumericDate 字段" }),
    ).toBeVisible();
    await expect(page.getByText("过期时间 exp")).toBeVisible();
    await expect(page.getByText("按 exp 字段，令牌尚未到期。")).toBeVisible();
  });

  test("严格拒绝段数和 Base64URL 错误", async ({ page }) => {
    const input = page.getByLabel("JWT Token");

    await input.fill("only.two");
    await page.getByRole("button", { name: "解析 JWT" }).click();
    await expect(page.getByRole("alert")).toContainText("必须正好包含");

    await input.fill("***.e30.c2ln");
    await page.getByRole("button", { name: "解析 JWT" }).click();
    await expect(page.getByRole("alert")).toContainText(
      "Header 必须是无填充 Base64URL",
    );

    await input.fill("e30=.e30.c2ln");
    await page.getByRole("button", { name: "解析 JWT" }).click();
    await expect(page.getByRole("alert")).toContainText("无填充 Base64URL");
  });

  test("非数值 NumericDate 会明确显示为警告而不是静默忽略", async ({
    page,
  }) => {
    await page
      .getByLabel("JWT Token")
      .fill(tokenFor({ exp: "tomorrow", nbf: null, iat: 0 }));
    await page.getByRole("button", { name: "解析 JWT" }).click();

    const timeRegion = page.getByRole("region", {
      name: "常见 NumericDate 字段",
    });
    await expect(timeRegion).toContainText("exp 必须是有限数值类型");
    await expect(timeRegion).toContainText("nbf 必须是有限数值类型");
    await expect(timeRegion).toContainText("1970-01-01T00:00:00.000Z");
  });

  test("拒绝会静默改值的超大整数，并允许用字符串无损查看", async ({ page }) => {
    const input = page.getByLabel("JWT Token");
    await input.fill(tokenFromJson('{"accountId":9007199254740993}'));
    await page.getByRole("button", { name: "解析 JWT" }).click();

    await expect(page.getByRole("alert")).toContainText(
      "超出 JavaScript 安全整数范围",
    );
    await expect(input).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByRole("heading", { name: "等待解析" })).toBeVisible();

    await input.fill(tokenFor({ accountId: "9007199254740993" }));
    await page.getByRole("button", { name: "解析 JWT" }).click();
    await expect(
      page.getByLabel("解码后的 JWT Payload", { exact: true }),
    ).toContainText('"accountId": "9007199254740993"');
  });

  test("常见有限小数可解析，会被静默改写的高精度小数会被拒绝", async ({
    page,
  }) => {
    const input = page.getByLabel("JWT Token");
    await input.fill(
      tokenFromJson(
        '{"fraction":1.5,"commonDecimal":0.1,"numericDate":1767225600.1,"exponent":1e3}',
      ),
    );
    await page.getByRole("button", { name: "解析 JWT" }).click();
    const payload = page.getByLabel("解码后的 JWT Payload", { exact: true });
    await expect(payload).toContainText('"fraction": 1.5');
    await expect(payload).toContainText('"commonDecimal": 0.1');
    await expect(payload).toContainText('"numericDate": 1767225600.1');
    await expect(payload).toContainText('"exponent": 1000');

    await input.fill(tokenFromJson('{"fraction":0.10000000000000001}'));
    await page.getByRole("button", { name: "解析 JWT" }).click();
    await expect(page.getByRole("alert")).toContainText("解析后会被改写为 0.1");
  });

  test("极深 Payload 在进入 JSON.parse 与 UI 序列化前被有界拒绝", async ({
    page,
  }) => {
    const depth = 65;
    const payloadJson = '{"deep":'.repeat(depth) + "null" + "}".repeat(depth);
    await page.getByLabel("JWT Token").fill(tokenFromJson(payloadJson));
    await page.getByRole("button", { name: "解析 JWT" }).click();

    await expect(page.getByRole("alert")).toContainText("嵌套超过 64 层");
    await expect(page.getByRole("heading", { name: "等待解析" })).toBeVisible();

    await page.getByRole("button", { name: "载入示例" }).click();
    await page.getByRole("button", { name: "解析 JWT" }).click();
    await expect(
      page.getByLabel("解码后的 JWT Payload", { exact: true }),
    ).toBeVisible();
  });

  test("复制纯文本结果，并下载带未验签标记且及时回收 Blob URL", async ({
    page,
  }) => {
    await page.getByRole("button", { name: "载入示例" }).click();
    await page.getByRole("button", { name: "解析 JWT" }).click();

    await page.evaluate(() => {
      const copied: string[] = [];
      const clipboard = {
        writeText: async (value: string) => {
          copied.push(value);
        },
      };
      try {
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: clipboard,
        });
      } catch {
        Object.defineProperty(Object.getPrototypeOf(navigator), "clipboard", {
          configurable: true,
          value: clipboard,
        });
      }
      Object.defineProperty(globalThis, "__jwtCopied", {
        configurable: true,
        value: copied,
      });

      const nativeCreate = URL.createObjectURL.bind(URL);
      const nativeRevoke = URL.revokeObjectURL.bind(URL);
      const created: string[] = [];
      const revoked: string[] = [];
      Object.defineProperties(URL, {
        createObjectURL: {
          configurable: true,
          value: (blob: Blob) => {
            const url = nativeCreate(blob);
            created.push(url);
            return url;
          },
        },
        revokeObjectURL: {
          configurable: true,
          value: (url: string) => {
            revoked.push(url);
            nativeRevoke(url);
          },
        },
      });
      Object.defineProperty(globalThis, "__jwtBlobUrls", {
        configurable: true,
        value: { created, revoked },
      });
    });

    await page
      .getByRole("button", { name: "复制解码后的 JWT Payload" })
      .click();
    const copied = await page.evaluate(
      () =>
        (globalThis as typeof globalThis & { __jwtCopied?: string[] })
          .__jwtCopied ?? [],
    );
    expect(copied).toHaveLength(1);
    expect(JSON.parse(copied[0] ?? "{}")).toMatchObject({
      sub: "online-tools-demo",
    });

    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "下载解析结果" }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("decoded-jwt.json");
    const downloaded = JSON.parse(await downloadText(download)) as {
      warning?: string;
      signature?: { present?: boolean; verified?: boolean };
    };
    expect(downloaded.warning).toContain("未验证签名");
    expect(downloaded.signature).toEqual({ present: true, verified: false });

    await expect
      .poll(() =>
        page.evaluate(() => {
          const probe = (
            globalThis as typeof globalThis & {
              __jwtBlobUrls?: { created: string[]; revoked: string[] };
            }
          ).__jwtBlobUrls;
          return probe
            ? {
                created: probe.created.length,
                revoked: probe.revoked.length,
                same: probe.created[0] === probe.revoked[0],
              }
            : null;
        }),
      )
      .toEqual({ created: 1, revoked: 1, same: true });
  });

  test("清空后不会保留 Token 或解析结果", async ({ page }) => {
    const canary = "JWT_PRIVATE_CANARY_中文🙂";
    await page.getByLabel("JWT Token").fill(tokenFor({ sub: canary }));
    await page.getByRole("button", { name: "解析 JWT" }).click();
    await page.getByRole("button", { name: "清空", exact: true }).click();

    await expect(page.getByLabel("JWT Token")).toHaveValue("");
    await expect(page.getByRole("heading", { name: "等待解析" })).toBeVisible();
    const persisted = await page.evaluate(() =>
      JSON.stringify({
        localStorage: Object.entries(localStorage),
        sessionStorage: Object.entries(sessionStorage),
        cookie: document.cookie,
        url: location.href,
      }),
    );
    expect(persisted).not.toContain(canary);

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByLabel("JWT Token")).toHaveValue("");
  });

  test("移动端无水平溢出且所有可见操作至少 44px 高", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.reload({ waitUntil: "networkidle" });
    await page.getByRole("button", { name: "载入示例" }).click();
    await page.getByRole("button", { name: "解析 JWT" }).click();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);

    const shortButtons = await page
      .locator(".jwt-tool button:visible")
      .evaluateAll((buttons) =>
        buttons
          .map((button) => ({
            name: button.textContent?.trim() ?? "",
            height: button.getBoundingClientRect().height,
          }))
          .filter(({ height }) => height < 44),
      );
    expect(shortButtons).toEqual([]);
  });
});

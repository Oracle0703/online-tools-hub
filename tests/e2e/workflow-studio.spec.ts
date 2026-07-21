import { Buffer } from "node:buffer";

import { expect, test, type Download, type Page } from "@playwright/test";

type PrivacyProbe = {
  clipboardReads: number;
  activeBlobUrls: Set<string>;
  createdBlobUrls: number;
  revokedBlobUrls: number;
};

async function installPrivacyProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const nativeCreate = URL.createObjectURL.bind(URL);
    const nativeRevoke = URL.revokeObjectURL.bind(URL);
    const probe: PrivacyProbe = {
      clipboardReads: 0,
      activeBlobUrls: new Set<string>(),
      createdBlobUrls: 0,
      revokedBlobUrls: 0,
    };
    const clipboard = {
      async read() {
        probe.clipboardReads += 1;
        return [];
      },
      async readText() {
        probe.clipboardReads += 1;
        return "UNEXPECTED_CLIPBOARD_BODY";
      },
      async write() {},
      async writeText() {},
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
    URL.createObjectURL = (object: Blob | MediaSource) => {
      const url = nativeCreate(object);
      probe.createdBlobUrls += 1;
      probe.activeBlobUrls.add(url);
      return url;
    };
    URL.revokeObjectURL = (url: string) => {
      probe.revokedBlobUrls += 1;
      probe.activeBlobUrls.delete(url);
      nativeRevoke(url);
    };
    Object.defineProperty(globalThis, "__workflowPrivacyProbe", {
      configurable: true,
      value: probe,
    });
  });
}

async function privacyProbe(page: Page) {
  return page.evaluate(() => {
    const probe = (
      globalThis as typeof globalThis & {
        __workflowPrivacyProbe?: PrivacyProbe;
      }
    ).__workflowPrivacyProbe;
    if (probe === undefined) throw new Error("privacy probe missing");
    return {
      clipboardReads: probe.clipboardReads,
      activeBlobUrls: [...probe.activeBlobUrls],
      createdBlobUrls: probe.createdBlobUrls,
      revokedBlobUrls: probe.revokedBlobUrls,
    };
  });
}

async function downloadBytes(download: Download): Promise<Buffer> {
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function openStudio(page: Page): Promise<void> {
  await page.goto("./workflows/base64-json-inspect/", {
    waitUntil: "networkidle",
  });
  await expect(page.locator("[data-workflow-studio]")).toBeVisible();
  await expect(page.locator("[data-workflow-batch]")).toBeVisible();
  await expect(page.locator("[data-batch-file-input]")).toBeEnabled();
}

test("Studio 在同一页面完成编辑、运行与中间预览", async ({ page }) => {
  await installPrivacyProbe(page);
  await openStudio(page);
  const initialUrl = page.url();

  const steps = page.locator("[data-workflow-step]");
  await expect(steps).toHaveCount(2);
  await expect(steps.nth(0)).toHaveAttribute(
    "data-operation-id",
    "base64.codec",
  );

  const moveDown = steps.nth(0).locator('[data-action="move-down"]');
  await moveDown.focus();
  await page.keyboard.press("Enter");
  await expect(steps.nth(0)).toHaveAttribute(
    "data-operation-id",
    "json.transform",
  );
  await expect(page.locator("[data-recipe-valid]")).toHaveAttribute(
    "data-recipe-valid",
    "false",
  );

  const moveBack = steps.nth(1).locator('[data-action="move-up"]');
  await moveBack.focus();
  await page.keyboard.press("Enter");
  await expect(steps.nth(0)).toHaveAttribute(
    "data-operation-id",
    "base64.codec",
  );
  await expect(page.locator("[data-recipe-valid]")).toHaveAttribute(
    "data-recipe-valid",
    "true",
  );

  await page
    .locator("[data-workflow-input]")
    .fill(
      Buffer.from('{"ok":true,"mode":"studio"}', "utf8").toString("base64"),
    );
  await page.locator('[data-action="run"]').click();
  await expect(page.locator("[data-workflow-studio]")).toHaveAttribute(
    "data-runtime-status",
    "succeeded",
    { timeout: 30_000 },
  );
  await expect(page.locator("[data-step-preview]").last()).toContainText(
    '"ok": true',
  );
  await expect(page.locator("[data-workflow-feedback]")).toHaveAttribute(
    "aria-live",
    "polite",
  );

  expect(page.url()).toBe(initialUrl);
  expect((await privacyProbe(page)).clipboardReads).toBe(0);
  const storage = await page.evaluate(() => ({
    local: Object.values(localStorage),
    session: Object.values(sessionStorage),
  }));
  expect(JSON.stringify(storage)).not.toContain("mode");
});

test("批处理隔离失败、支持重试、ZIP 与无正文隐私回执", async ({ page }) => {
  await installPrivacyProbe(page);
  await openStudio(page);

  const sourceNameCanary = "PRIVATE_SOURCE_NAME_7f6a.json";
  const failedNameCanary = "FAILED_SOURCE_NAME_1c9d.txt";
  const privateBodyCanary = "PRIVATE_BODY_CANARY_d2b4";
  await page.locator("[data-batch-file-input]").setInputFiles([
    {
      name: sourceNameCanary,
      mimeType: "text/plain",
      buffer: Buffer.from(
        Buffer.from(
          JSON.stringify({ ok: true, value: privateBodyCanary }),
          "utf8",
        ).toString("base64"),
      ),
    },
    {
      name: failedNameCanary,
      mimeType: "text/plain",
      buffer: Buffer.from("%%%not-base64%%%", "utf8"),
    },
  ]);

  await expect(page.locator("[data-batch-item]")).toHaveCount(2);
  await page.locator('[data-action="run-batch"]').click();
  await expect(page.locator("[data-workflow-batch]")).toHaveAttribute(
    "data-batch-status",
    "completed",
    { timeout: 30_000 },
  );
  await expect(page.locator('[data-item-status="succeeded"]')).toHaveCount(1);
  await expect(page.locator('[data-item-status="failed"]')).toHaveCount(1);
  await expect(page.locator("[data-batch-feedback]")).toContainText(
    "失败项可以单独重试",
  );

  await page.locator('[data-action="retry-item"]').click();
  await expect(page.locator('[data-item-status="failed"]')).toHaveCount(1, {
    timeout: 30_000,
  });

  const receiptDownloadPromise = page.waitForEvent("download");
  await page.locator('[data-action="download-receipt"]').click();
  const receiptDownload = await receiptDownloadPromise;
  expect(receiptDownload.suggestedFilename()).toBe(
    "workflow-privacy-receipt.json",
  );
  const receipt = (await downloadBytes(receiptDownload)).toString("utf8");
  expect(JSON.parse(receipt)).toMatchObject({
    format: "online-tools-hub/privacy-receipt",
    localOnly: true,
    summary: { total: 2, succeeded: 1, failed: 1 },
  });
  for (const secret of [
    sourceNameCanary,
    failedNameCanary,
    privateBodyCanary,
  ]) {
    expect(receipt).not.toContain(secret);
  }

  const zipDownloadPromise = page.waitForEvent("download");
  await page.locator('[data-action="download-zip"]').click();
  const zipDownload = await zipDownloadPromise;
  expect(zipDownload.suggestedFilename()).toBe("workflow-results.zip");
  const zip = await downloadBytes(zipDownload);
  expect(zip.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  expect(zip.toString("utf8")).toContain("workflow-result-001.json");
  expect(zip.toString("utf8")).not.toContain(sourceNameCanary);
  expect(zip.toString("utf8")).not.toContain(failedNameCanary);

  const resultDownloadPromise = page.waitForEvent("download");
  await page.locator('[data-action="download-result"]').click();
  const resultDownload = await resultDownloadPromise;
  expect(resultDownload.suggestedFilename()).toBe("workflow-result-001.json");
  expect((await privacyProbe(page)).createdBlobUrls).toBeGreaterThan(0);

  await page.locator('[data-action="clear-batch"]').click();
  await expect(page.locator("[data-batch-item]")).toHaveCount(0);
  await expect
    .poll(async () => (await privacyProbe(page)).activeBlobUrls)
    .toEqual([]);

  const browserState = await page.evaluate(() => ({
    href: location.href,
    local: Object.values(localStorage),
    session: Object.values(sessionStorage),
  }));
  expect(JSON.stringify(browserState)).not.toContain(sourceNameCanary);
  expect(JSON.stringify(browserState)).not.toContain(failedNameCanary);
  expect((await privacyProbe(page)).clipboardReads).toBe(0);
});

test("pagehide 会释放批处理文件引用并重置 BFCache 页面", async ({ page }) => {
  await installPrivacyProbe(page);
  await openStudio(page);

  const sourceNameCanary = "PAGEHIDE_PRIVATE_NAME_93ad.txt";
  await page.locator("[data-batch-file-input]").setInputFiles({
    name: sourceNameCanary,
    mimeType: "text/plain",
    buffer: Buffer.from("eyJyZWFkeSI6dHJ1ZX0=", "utf8"),
  });
  await expect(page.locator("[data-batch-item]")).toHaveCount(1);
  await expect(page.getByText(sourceNameCanary)).toBeVisible();

  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));

  await expect(page.locator("[data-batch-item]")).toHaveCount(0);
  await expect(page.getByText(sourceNameCanary)).toHaveCount(0);
  await expect(page.locator("[data-batch-feedback]")).toContainText(
    "文件引用、结果和下载资源均已释放",
  );
  await expect
    .poll(() =>
      page
        .locator("[data-batch-file-input]")
        .evaluate((input: HTMLInputElement) => input.files?.length ?? 0),
    )
    .toBe(0);
  expect((await privacyProbe(page)).activeBlobUrls).toEqual([]);
});

test("360px 下 Studio 与批处理队列无溢出且触控目标达到 44px", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await openStudio(page);
  await page.locator("[data-batch-file-input]").setInputFiles({
    name: "很长的移动端文件名称-中文🙂-不会撑破布局.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("eyJtb2JpbGUiOnRydWV9", "utf8"),
  });

  const layout = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    smallTargets: [
      ...document.querySelectorAll<HTMLElement>(
        "[data-workflow-studio] button, [data-workflow-studio] select, .workflow-studio__batch-dropzone, .workflow-studio__privacy a",
      ),
    ]
      .filter((element) => element.getClientRects().length > 0)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          text: element.textContent?.trim(),
          width: rect.width,
          height: rect.height,
        };
      })
      .filter(({ width, height }) => width < 43.5 || height < 43.5),
  }));

  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth + 1);
  expect(layout.smallTargets).toEqual([]);
});

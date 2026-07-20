import { Buffer } from "node:buffer";

import { expect, test, type Download, type Page } from "@playwright/test";

const PNG_FIXTURE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAYAAAC09K7GAAAANUlEQVR4nBXIMREAMAgEwVdHHRF4SYMXbHxNg5zLZMuVxAktpWZ0kRIil8pm8ochvJSb8eUBpjAeBjxGdD0AAAAASUVORK5CYII=",
  "base64",
);

function crc32(bytes: Uint8Array): number {
  let checksum = 0xffff_ffff;
  for (const byte of bytes) {
    checksum ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      checksum = (checksum >>> 1) ^ (checksum & 1 ? 0xedb8_8320 : 0);
    }
  }
  return (checksum ^ 0xffff_ffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.byteLength);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, checksum]);
}

function apngFixture(): Buffer {
  const animationControl = Buffer.alloc(8);
  animationControl.writeUInt32BE(2, 0);
  animationControl.writeUInt32BE(0, 4);

  // PNG signature + IHDR chunk always occupies the first 33 bytes.
  return Buffer.concat([
    PNG_FIXTURE.subarray(0, 33),
    pngChunk("acTL", animationControl),
    PNG_FIXTURE.subarray(33),
  ]);
}

async function addPng(page: Page, name = "sample.png"): Promise<void> {
  await page
    .getByLabel("选择 JPEG、PNG 或 WebP 图片")
    .setInputFiles({ name, mimeType: "image/png", buffer: PNG_FIXTURE });
  await expect(
    page.getByRole("list", { name: "图片处理结果" }).getByRole("listitem"),
  ).toContainText(name);
}

async function compress(page: Page, count = 1): Promise<void> {
  await page
    .getByRole("button", { name: `压缩 ${count} 张图片`, exact: true })
    .click();
  await expect(page.locator(".image-compressor-tool__feedback")).toContainText(
    `已完成 ${count} 张图片`,
    { timeout: 30_000 },
  );
}

async function downloadBytes(download: Download): Promise<Buffer> {
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function listZipEntries(bytes: Buffer): string[] {
  let endOffset = -1;
  for (let offset = bytes.length - 22; offset >= 0; offset -= 1) {
    if (bytes.readUInt32LE(offset) === 0x0605_4b50) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset < 0) throw new Error("ZIP end-of-central-directory not found");

  const entryCount = bytes.readUInt16LE(endOffset + 10);
  let offset = bytes.readUInt32LE(endOffset + 16);
  const names: string[] = [];
  for (let index = 0; index < entryCount; index += 1) {
    if (bytes.readUInt32LE(offset) !== 0x0201_4b50) {
      throw new Error("Invalid ZIP central-directory entry");
    }
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    names.push(
      bytes.subarray(offset + 46, offset + 46 + nameLength).toString(),
    );
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return names;
}

test.describe("图片压缩与格式转换", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("./tools/image-compressor/", { waitUntil: "networkidle" });
  });

  test("有效 PNG 可在本地处理、展示尺寸并下载单张结果", async ({ page }) => {
    await addPng(page, "透明 示例.png");

    const item = page
      .getByRole("list", { name: "图片处理结果" })
      .getByRole("listitem");
    await expect(item).toContainText("PNG · 4 × 3");

    await compress(page);
    await expect(
      item.locator(".image-compressor-tool__result-meta"),
    ).toContainText("→ 4 × 3");
    await expect(
      item.locator(".image-compressor-tool__result-meta"),
    ).toContainText(/压缩结果未更小，已保留原图|节省/u);

    const downloadPromise = page.waitForEvent("download");
    await item.getByRole("button", { name: /^下载 /u }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(
      /^透明 示例-(?:original|compressed)\.png$/u,
    );
    const bytes = await downloadBytes(download);
    expect([...bytes.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  test("可显式转换为 JPEG 并下载正确格式", async ({ page }) => {
    await addPng(page, "alpha.png");
    await page.getByLabel("输出格式").selectOption("jpeg");
    await compress(page);

    const item = page
      .getByRole("list", { name: "图片处理结果" })
      .getByRole("listitem");
    const downloadPromise = page.waitForEvent("download");
    await item.getByRole("button", { name: /^下载 /u }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("alpha-compressed.jpg");
    const bytes = await downloadBytes(download);
    expect([...bytes.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
  });

  test("浏览器支持时可显式转换为 WebP", async ({ page }) => {
    const supportsWebP = await page.evaluate(
      () =>
        new Promise<boolean>((resolve) => {
          const canvas = document.createElement("canvas");
          canvas.width = 1;
          canvas.height = 1;
          canvas.toBlob(
            (blob) => resolve(blob?.type === "image/webp"),
            "image/webp",
            0.8,
          );
        }),
    );
    test.skip(!supportsWebP, "当前浏览器不支持 WebP 编码");

    await addPng(page, "webp-source.png");
    await page.getByLabel("输出格式").selectOption("webp");
    await compress(page);

    const item = page
      .getByRole("list", { name: "图片处理结果" })
      .getByRole("listitem");
    const downloadPromise = page.waitForEvent("download");
    await item.getByRole("button", { name: /^下载 /u }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("webp-source-compressed.webp");
    const bytes = await downloadBytes(download);
    expect(bytes.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(bytes.subarray(8, 12).toString("ascii")).toBe("WEBP");
  });

  test("拒绝仅伪装扩展名与 MIME 的 PNG", async ({ page }) => {
    await page.getByLabel("选择 JPEG、PNG 或 WebP 图片").setInputFiles({
      name: "spoofed.png",
      mimeType: "image/png",
      buffer: Buffer.from("this is not a png", "utf8"),
    });

    await expect(page.getByRole("alert")).toContainText("无法识别图片格式");
    await expect(page.getByRole("list", { name: "图片处理结果" })).toHaveCount(
      0,
    );
    await expect(page.locator("[data-privacy-canary-action]")).toBeDisabled();
  });

  test("拒绝动画 PNG，避免静默丢失帧", async ({ page }) => {
    await page.getByLabel("选择 JPEG、PNG 或 WebP 图片").setInputFiles({
      name: "animated.png",
      mimeType: "image/png",
      buffer: apngFixture(),
    });

    await expect(page.getByRole("alert")).toContainText(
      "animated.png 是动画 PNG",
    );
    await expect(page.getByRole("list", { name: "图片处理结果" })).toHaveCount(
      0,
    );
  });

  test("两张同名图片可批量打包为名称唯一的 ZIP", async ({ page }) => {
    await page.getByLabel("选择 JPEG、PNG 或 WebP 图片").setInputFiles([
      { name: "same.png", mimeType: "image/png", buffer: PNG_FIXTURE },
      { name: "same.png", mimeType: "image/png", buffer: PNG_FIXTURE },
    ]);
    await expect(
      page.getByRole("list", { name: "图片处理结果" }).getByRole("listitem"),
    ).toHaveCount(2);
    await compress(page, 2);

    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "下载全部 ZIP" }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("compressed-images.zip");

    const archive = await downloadBytes(download);
    expect([...archive.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    const entries = listZipEntries(archive);
    expect(entries).toHaveLength(2);
    expect(new Set(entries).size).toBe(2);
    expect(entries).toEqual([
      expect.stringMatching(/^same-(?:original|compressed)\.png$/u),
      expect.stringMatching(/^same-(?:original|compressed)-2\.png$/u),
    ]);
  });
});

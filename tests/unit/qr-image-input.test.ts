import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { QR_CODE_LIMITS } from "../../src/tools/qr-code/contract";
import {
  inspectQrImageBytes,
  validateQrImageFileSize,
} from "../../src/tools/qr-code/image-input";

const fixtureDirectory = path.resolve("tests/fixtures/qr-code");

async function fixture(name: string) {
  return new Uint8Array(await readFile(path.join(fixtureDirectory, name)));
}

function findAscii(bytes: Uint8Array, value: string) {
  const needle = new TextEncoder().encode(value);
  for (let offset = 0; offset <= bytes.length - needle.length; offset += 1) {
    if (needle.every((byte, index) => bytes[offset + index] === byte)) {
      return offset;
    }
  }
  return -1;
}

describe("QR image input admission", () => {
  it.each([
    ["unicode.png", "png", 512, 512],
    ["rotated.jpg", "jpeg", 512, 512],
    ["inverted.webp", "webp", 512, 512],
    ["low-resolution.png", "png", 112, 112],
  ] as const)(
    "reads %s from container bytes",
    async (name, format, width, height) => {
      expect(inspectQrImageBytes(await fixture(name))).toEqual({
        ok: true,
        value: expect.objectContaining({ format, width, height }),
      });
    },
  );

  it("rejects unsupported and truncated containers before decode", async () => {
    expect(inspectQrImageBytes(new TextEncoder().encode("<svg/>"))).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "unsupported-image" }),
    });
    expect(inspectQrImageBytes(await fixture("corrupt.png"))).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "corrupt-image" }),
    });
  });

  it("rejects an APNG marker and a committed animated WebP", async () => {
    const png = await fixture("unicode.png");
    const imageDataType = findAscii(png, "IDAT");
    expect(imageDataType).toBeGreaterThan(4);
    const chunk = new Uint8Array([
      0, 0, 0, 8, 97, 99, 84, 76, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0,
    ]);
    const apng = new Uint8Array(png.length + chunk.length);
    apng.set(png.subarray(0, imageDataType - 4));
    apng.set(chunk, imageDataType - 4);
    apng.set(png.subarray(imageDataType - 4), imageDataType - 4 + chunk.length);
    expect(inspectQrImageBytes(apng)).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "animated-image" }),
    });

    expect(inspectQrImageBytes(await fixture("animated.webp"))).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "animated-image" }),
    });
  });

  it("rejects a valid, highly compressed image above the source-pixel budget", async () => {
    expect(inspectQrImageBytes(await fixture("over-limit.png"))).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "source-too-large" }),
    });
  });

  it("rejects extended WebP containers whose canvas hides frame dimensions", async () => {
    const simpleWebp = await fixture("inverted.webp");
    const vp8x = new Uint8Array([
      86, 80, 56, 88, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ]);
    const mismatched = new Uint8Array(simpleWebp.length + vp8x.length);
    mismatched.set(simpleWebp.subarray(0, 12));
    mismatched.set(vp8x, 12);
    mismatched.set(simpleWebp.subarray(12), 12 + vp8x.length);
    const riffSize = mismatched.length - 8;
    mismatched[4] = riffSize & 0xff;
    mismatched[5] = (riffSize >>> 8) & 0xff;
    mismatched[6] = (riffSize >>> 16) & 0xff;
    mismatched[7] = (riffSize >>> 24) & 0xff;

    expect(inspectQrImageBytes(mismatched)).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "corrupt-image" }),
    });
  });

  it("checks compressed file byte limits before reading pixels", () => {
    expect(validateQrImageFileSize(0)?.code).toBe("empty-file");
    expect(validateQrImageFileSize(QR_CODE_LIMITS.maxFileBytes + 1)?.code).toBe(
      "file-too-large",
    );
    expect(validateQrImageFileSize(QR_CODE_LIMITS.maxFileBytes)).toBeNull();
  });
});

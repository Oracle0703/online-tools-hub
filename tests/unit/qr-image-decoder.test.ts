import { afterEach, describe, expect, it, vi } from "vitest";

import { decodeQrImageFile } from "../../src/components/tools/qr-image-decoder";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("QR browser image decoder", () => {
  it("composites transparent pixels onto white before reading RGBA", async () => {
    const close = vi.fn();
    const bitmap = { width: 1, height: 1, close };
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => bitmap),
    );

    const fillRect = vi.fn();
    const drawImage = vi.fn();
    const pixels = new Uint8ClampedArray([0, 0, 0, 0]);
    const context = {
      fillStyle: "",
      fillRect,
      drawImage,
      getImageData: vi.fn(() => ({ data: pixels })),
    };
    const getContext = vi.fn(() => context);
    const canvas = { width: 0, height: 0, getContext };
    vi.stubGlobal("document", {
      createElement: vi.fn(() => canvas),
    });

    const result = await decodeQrImageFile(
      new File([new Uint8Array([1])], "transparent.png", {
        type: "image/png",
      }),
      new AbortController().signal,
    );

    expect(getContext).toHaveBeenCalledWith("2d", {
      alpha: false,
      willReadFrequently: true,
    });
    expect(context.fillStyle).toBe("#ffffff");
    expect(fillRect).toHaveBeenCalledWith(0, 0, 1, 1);
    expect(drawImage).toHaveBeenCalledWith(bitmap, 0, 0, 1, 1);
    expect(fillRect.mock.invocationCallOrder[0]).toBeLessThan(
      drawImage.mock.invocationCallOrder[0]!,
    );
    expect(result).toMatchObject({
      width: 1,
      height: 1,
      sourceWidth: 1,
      sourceHeight: 1,
      resized: false,
    });
    expect(result.rgba).toBe(pixels.buffer);
    expect(close).toHaveBeenCalledOnce();
    expect(canvas).toMatchObject({ width: 0, height: 0 });
  });
});

import UPNG from "@upng/upng-js/dist/UPNG.esm.js";

import { MAX_IMAGE_PIXELS } from "./core";

/** Shared CPU boundary used by both the image tool and Operation Runtime. */
export function encodeRgbaToPng(
  rgba: ArrayBuffer,
  width: number,
  height: number,
  colorCount: number,
): ArrayBuffer {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0
  ) {
    throw new RangeError("图片尺寸无效。");
  }
  if (!Number.isSafeInteger(colorCount) || colorCount < 2 || colorCount > 256) {
    throw new RangeError("PNG 调色板颜色数必须在 2–256 之间。");
  }
  if (width > Math.floor(MAX_IMAGE_PIXELS / height)) {
    throw new RangeError("图片像素总数超过本地处理安全限制。");
  }

  const expectedBytes = width * height * 4;
  if (
    !Number.isSafeInteger(expectedBytes) ||
    rgba.byteLength !== expectedBytes
  ) {
    throw new RangeError("像素数据长度与图片尺寸不匹配。");
  }

  const installedWorkerAlias = installUpngWorkerAlias();
  try {
    return UPNG.encode([rgba], width, height, colorCount);
  } finally {
    if (installedWorkerAlias) {
      Reflect.deleteProperty(globalThis, "window");
    }
  }
}

// UPNG's large-image path checks window.UZIP. The alias is local-only and
// exposes the already guarded Worker global rather than a browser Window.
function installUpngWorkerAlias(): boolean {
  const scope = globalThis as typeof globalThis & { window?: unknown };
  if ("window" in scope) return false;

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: globalThis,
  });
  return true;
}

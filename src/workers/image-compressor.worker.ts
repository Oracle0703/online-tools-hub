import UPNG from "@upng/upng-js";

interface PngEncodeRequest {
  id: number;
  rgba: ArrayBuffer;
  width: number;
  height: number;
  colorCount: number;
}

type PngEncodeResponse =
  | { id: number; ok: true; png: ArrayBuffer }
  | { id: number; ok: false; error: string };

interface WorkerScope {
  window?: unknown;
  onmessage: ((event: MessageEvent<PngEncodeRequest>) => void) | null;
  postMessage(message: PngEncodeResponse, transfer?: Transferable[]): void;
}

const workerScope = globalThis as unknown as WorkerScope;
const MAX_IMAGE_PIXELS = 40_000_000;

// UPNG's large-image fast path checks window.UZIP. Give the module the same
// harmless global alias inside a worker so that path cannot throw.
if (!("window" in workerScope)) {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: globalThis,
  });
}

workerScope.onmessage = (event) => {
  const { id, rgba, width, height, colorCount } = event.data;

  try {
    if (!Number.isSafeInteger(id) || id < 0) {
      throw new RangeError("无效的压缩任务编号。");
    }
    if (
      !Number.isSafeInteger(width) ||
      !Number.isSafeInteger(height) ||
      width <= 0 ||
      height <= 0
    ) {
      throw new RangeError("图片尺寸无效。");
    }
    if (
      !Number.isSafeInteger(colorCount) ||
      colorCount < 2 ||
      colorCount > 256
    ) {
      throw new RangeError("PNG 调色板颜色数必须在 2–256 之间。");
    }

    const expectedBytes = width * height * 4;
    if (width > Math.floor(MAX_IMAGE_PIXELS / height)) {
      throw new RangeError("图片像素总数超过本地处理安全限制。");
    }
    if (
      !Number.isSafeInteger(expectedBytes) ||
      rgba.byteLength !== expectedBytes
    ) {
      throw new RangeError("像素数据长度与图片尺寸不匹配。");
    }

    const png = UPNG.encode([rgba], width, height, colorCount);
    workerScope.postMessage({ id, ok: true, png }, [png]);
  } catch (error) {
    workerScope.postMessage({
      id: Number.isSafeInteger(id) ? id : -1,
      ok: false,
      error: error instanceof Error ? error.message : "PNG 编码失败。",
    });
  }
};

export {};

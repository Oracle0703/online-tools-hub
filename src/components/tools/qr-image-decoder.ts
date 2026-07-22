import {
  calculateQrScanDimensions,
  QR_CODE_LIMITS,
} from "../../tools/qr-code/contract";

export type QrImageDecodeErrorCode =
  "cancelled" | "decode-failed" | "source-too-large" | "canvas-unavailable";

export class QrImageDecodeError extends Error {
  readonly code: QrImageDecodeErrorCode;

  constructor(code: QrImageDecodeErrorCode, message: string) {
    super(message);
    this.name = "QrImageDecodeError";
    this.code = code;
  }
}

export interface DecodedQrPixels {
  readonly rgba: ArrayBuffer;
  readonly width: number;
  readonly height: number;
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly resized: boolean;
}

interface DecodedSource {
  readonly source: CanvasImageSource;
  readonly width: number;
  readonly height: number;
  close(): void;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new QrImageDecodeError(
      "cancelled",
      "二维码识别已取消，临时图片已释放。",
    );
  }
}

async function decodeWithHtmlImage(
  file: File,
  signal: AbortSignal,
): Promise<DecodedSource> {
  const objectUrl = URL.createObjectURL(file);
  const image = new Image();
  image.decoding = "async";
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    image.removeAttribute("src");
    URL.revokeObjectURL(objectUrl);
  };

  try {
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        signal.removeEventListener("abort", handleAbort);
        image.onload = null;
        image.onerror = null;
      };
      const handleAbort = () => {
        cleanup();
        close();
        reject(
          new QrImageDecodeError(
            "cancelled",
            "二维码识别已取消，临时图片已释放。",
          ),
        );
      };
      image.onload = () => {
        cleanup();
        resolve();
      };
      image.onerror = () => {
        cleanup();
        reject(
          new QrImageDecodeError(
            "decode-failed",
            "浏览器无法解码这张图片；文件可能已损坏。",
          ),
        );
      };
      signal.addEventListener("abort", handleAbort, { once: true });
      image.src = objectUrl;
    });
    throwIfAborted(signal);
    if (image.naturalWidth <= 0 || image.naturalHeight <= 0) {
      throw new QrImageDecodeError(
        "decode-failed",
        "浏览器没有返回有效图片尺寸。",
      );
    }
    return {
      source: image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      close,
    };
  } catch (error) {
    close();
    throw error;
  }
}

async function decodeSource(
  file: File,
  signal: AbortSignal,
): Promise<DecodedSource> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file, {
        imageOrientation: "from-image",
      });
      if (signal.aborted) {
        bitmap.close();
        throwIfAborted(signal);
      }
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        close: () => bitmap.close(),
      };
    } catch (error) {
      if (error instanceof QrImageDecodeError) throw error;
      throwIfAborted(signal);
      // Safari and older Chromium builds may need the local Blob URL fallback.
    }
  }
  return decodeWithHtmlImage(file, signal);
}

export async function decodeQrImageFile(
  file: File,
  signal: AbortSignal,
): Promise<DecodedQrPixels> {
  throwIfAborted(signal);
  const decoded = await decodeSource(file, signal);
  let canvas: HTMLCanvasElement | null = null;
  try {
    throwIfAborted(signal);
    if (
      !Number.isSafeInteger(decoded.width) ||
      !Number.isSafeInteger(decoded.height) ||
      decoded.width <= 0 ||
      decoded.height <= 0 ||
      decoded.width > QR_CODE_LIMITS.maxSourceEdge ||
      decoded.height > QR_CODE_LIMITS.maxSourceEdge ||
      decoded.width >
        Math.floor(QR_CODE_LIMITS.maxSourcePixels / decoded.height)
    ) {
      throw new QrImageDecodeError(
        "source-too-large",
        "解码后的图片超过 16 MP 或 8,192 px 单边上限。",
      );
    }

    const target = calculateQrScanDimensions(decoded.width, decoded.height);
    if (target.width <= 0 || target.height <= 0) {
      throw new QrImageDecodeError(
        "decode-failed",
        "无法计算安全的二维码识别尺寸。",
      );
    }

    canvas = document.createElement("canvas");
    canvas.width = target.width;
    canvas.height = target.height;
    const context = canvas.getContext("2d", {
      alpha: false,
      willReadFrequently: true,
    });
    if (!context) {
      throw new QrImageDecodeError(
        "canvas-unavailable",
        "当前浏览器无法创建本地像素画布。",
      );
    }
    // jsQR consumes RGB and intentionally ignores alpha. Composite transparent
    // QR exports onto white so transparent backgrounds do not become black.
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, target.width, target.height);
    context.drawImage(decoded.source, 0, 0, target.width, target.height);
    throwIfAborted(signal);
    const imageData = context.getImageData(0, 0, target.width, target.height);
    const rgba = imageData.data.buffer as ArrayBuffer;
    if (rgba.byteLength !== target.width * target.height * 4) {
      throw new QrImageDecodeError(
        "decode-failed",
        "浏览器返回的 RGBA 像素长度无效。",
      );
    }
    throwIfAborted(signal);
    return {
      rgba,
      width: target.width,
      height: target.height,
      sourceWidth: decoded.width,
      sourceHeight: decoded.height,
      resized: target.resized,
    };
  } catch (error) {
    if (error instanceof QrImageDecodeError) throw error;
    throw new QrImageDecodeError(
      "decode-failed",
      "图片像素读取失败；文件可能已损坏或浏览器内存不足。",
    );
  } finally {
    decoded.close();
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
  }
}

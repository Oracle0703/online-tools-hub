import {
  WorkflowFileInputError,
  type WorkflowImageDecodeRequest,
} from "../../workflows/file-input";
import {
  getImageMemoryLimits,
  validateImageSourceMemory,
} from "../../tools/image-compressor/core";
import type { RgbaImageOperationInput } from "../../operations/contract";

interface BrowserImageSource {
  readonly source: CanvasImageSource;
  readonly width: number;
  readonly height: number;
  close(): void;
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new WorkflowFileInputError("cancelled");
}

function imageMemoryEnvironment(): {
  deviceMemoryGiB?: number;
  coarsePointer?: boolean;
} {
  const deviceMemoryGiB =
    typeof navigator === "undefined"
      ? undefined
      : (navigator as Navigator & { readonly deviceMemory?: number })
          .deviceMemory;
  return {
    deviceMemoryGiB,
    coarsePointer:
      typeof matchMedia === "function"
        ? matchMedia("(pointer: coarse)").matches
        : undefined,
  };
}

async function decodeHtmlImage(
  file: WorkflowImageDecodeRequest["file"],
  signal?: AbortSignal,
): Promise<BrowserImageSource> {
  if (
    typeof Image !== "function" ||
    typeof URL === "undefined" ||
    typeof URL.createObjectURL !== "function" ||
    typeof URL.revokeObjectURL !== "function"
  ) {
    throw new WorkflowFileInputError("decode-failed");
  }
  throwIfCancelled(signal);

  const url = URL.createObjectURL(file as Blob);
  const image = new Image();
  image.decoding = "async";
  try {
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => signal?.removeEventListener("abort", onAbort);
      const onAbort = () => {
        cleanup();
        image.src = "";
        reject(new WorkflowFileInputError("cancelled"));
      };
      image.onload = () => {
        cleanup();
        resolve();
      };
      image.onerror = () => {
        cleanup();
        reject(new WorkflowFileInputError("decode-failed"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      image.src = url;
    });
    throwIfCancelled(signal);
    return {
      source: image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      close() {
        image.onload = null;
        image.onerror = null;
        image.src = "";
        URL.revokeObjectURL(url);
      },
    };
  } catch (error) {
    image.onload = null;
    image.onerror = null;
    image.src = "";
    URL.revokeObjectURL(url);
    throw error;
  }
}

async function decodeBrowserSource(
  file: WorkflowImageDecodeRequest["file"],
  signal?: AbortSignal,
): Promise<BrowserImageSource> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file as Blob, {
        imageOrientation: "from-image",
      });
      if (signal?.aborted) {
        bitmap.close();
        throw new WorkflowFileInputError("cancelled");
      }
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        close: () => bitmap.close(),
      };
    } catch (error) {
      if (error instanceof WorkflowFileInputError) throw error;
      // Safari and embedded WebViews can require HTMLImageElement decoding.
    }
  }
  return decodeHtmlImage(file, signal);
}

/**
 * Decodes one already-inspected local image. The caller invokes this lazily so
 * a batch never retains decoded pixels for more than one queued item.
 */
export async function decodeWorkflowImageInBrowser(
  request: WorkflowImageDecodeRequest,
): Promise<RgbaImageOperationInput> {
  if (typeof document === "undefined") {
    throw new WorkflowFileInputError("decode-failed");
  }
  throwIfCancelled(request.signal);
  const source = await decodeBrowserSource(request.file, request.signal);
  let canvas: HTMLCanvasElement | undefined;
  try {
    const limits = getImageMemoryLimits(
      request.memoryEnvironment ?? imageMemoryEnvironment(),
    );
    const memory = validateImageSourceMemory(
      source.width,
      source.height,
      limits,
    );
    if (!memory.ok) {
      throw new WorkflowFileInputError("device-memory-limit");
    }
    if (
      source.width * source.height !==
      request.declaredWidth * request.declaredHeight
    ) {
      throw new WorkflowFileInputError("invalid-image");
    }
    throwIfCancelled(request.signal);

    canvas = document.createElement("canvas");
    canvas.width = source.width;
    canvas.height = source.height;
    const context = canvas.getContext("2d", {
      alpha: true,
      willReadFrequently: true,
    });
    if (context === null) throw new WorkflowFileInputError("decode-failed");
    context.drawImage(source.source, 0, 0, source.width, source.height);
    throwIfCancelled(request.signal);
    const pixels = context.getImageData(0, 0, source.width, source.height);
    throwIfCancelled(request.signal);
    return {
      kind: "rgba-image",
      width: source.width,
      height: source.height,
      data: pixels.data,
    };
  } catch (error) {
    if (error instanceof WorkflowFileInputError) throw error;
    throw new WorkflowFileInputError("decode-failed");
  } finally {
    source.close();
    if (canvas !== undefined) {
      canvas.width = 1;
      canvas.height = 1;
    }
  }
}

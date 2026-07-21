import { installOperationWorkerPrivacyGuards } from "../operations/privacy-guard";

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
// GitHub Pages cannot attach a dedicated CSP response header to this Worker.
// Install the fail-closed boundary before dynamically loading encoder code.
installOperationWorkerPrivacyGuards(globalThis);

workerScope.onmessage = (event) => {
  void encodePng(event.data);
};

async function encodePng(request: PngEncodeRequest): Promise<void> {
  const { id, rgba, width, height, colorCount } = request;

  try {
    if (!Number.isSafeInteger(id) || id < 0) {
      throw new RangeError("无效的压缩任务编号。");
    }
    const { encodeRgbaToPng } =
      await import("../tools/image-compressor/png-encoder");
    const png = encodeRgbaToPng(rgba, width, height, colorCount);
    workerScope.postMessage({ id, ok: true, png }, [png]);
  } catch (error) {
    workerScope.postMessage({
      id: Number.isSafeInteger(id) ? id : -1,
      ok: false,
      error: error instanceof Error ? error.message : "PNG 编码失败。",
    });
  }
}

export {};

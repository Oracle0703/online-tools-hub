import { encodeRgbaToPng } from "../tools/image-compressor/png-encoder";

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
workerScope.onmessage = (event) => {
  const { id, rgba, width, height, colorCount } = event.data;

  try {
    if (!Number.isSafeInteger(id) || id < 0) {
      throw new RangeError("无效的压缩任务编号。");
    }
    const png = encodeRgbaToPng(rgba, width, height, colorCount);
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

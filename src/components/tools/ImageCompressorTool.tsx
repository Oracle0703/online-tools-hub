import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type CSSProperties,
} from "react";

import { ToolWorkspace, ToolWorkspaceHeader } from "../ToolWorkspace";
import {
  MAX_IMAGE_FILES,
  calculateMemorySafeSize,
  createOutputFileName,
  createStoreZip,
  formatBytes,
  formatSavings,
  getImageMemoryLimits,
  getImageFormatDescriptor,
  inspectImageData,
  qualityToPngPaletteColors,
  readImageDimensions,
  resolveOutputFormat,
  validateImageSourceMemory,
  validateImageQueue,
  type ImageMemoryLimits,
  type ImageOutputFormat,
  type SupportedImageFormat,
} from "../../tools/image-compressor/core";

import "./ImageCompressorTool.css";

type ItemStatus = "queued" | "processing" | "done" | "error";

interface ImageItem {
  id: string;
  file: File;
  format: SupportedImageFormat;
  width: number;
  height: number;
  sourceUrl: string;
  status: ItemStatus;
  resultBlob?: Blob;
  resultUrl?: string;
  resultName?: string;
  resultFormat?: SupportedImageFormat;
  resultWidth?: number;
  resultHeight?: number;
  keptOriginal?: boolean;
  memoryLimited?: boolean;
  error?: string;
}

interface CompressionSettings {
  quality: number;
  outputFormat: ImageOutputFormat;
  maximumEdge: number;
  jpegBackground: string;
  memoryLimits: ImageMemoryLimits;
}

type Feedback = {
  kind: "idle" | "success" | "warning" | "error";
  message: string;
};

type PngWorkerResponse =
  | { id: number; ok: true; png: ArrayBuffer }
  | { id: number; ok: false; error: string };

interface PendingPngTask {
  resolve: (value: ArrayBuffer) => void;
  reject: (reason: Error) => void;
  timeout: number;
}

interface DecodedImage {
  source: CanvasImageSource;
  width: number;
  height: number;
  close(): void;
}

const QUALITY_PRESETS = [
  [65, "更小"],
  [82, "均衡"],
  [92, "更清晰"],
] as const;

const OUTPUT_FORMATS: ReadonlyArray<[ImageOutputFormat, string]> = [
  ["original", "保持原格式（推荐）"],
  ["webp", "WebP"],
  ["jpeg", "JPEG"],
  ["png", "PNG"],
];

const MAXIMUM_EDGES = [
  [0, "不调整尺寸"],
  [3840, "3840 px（4K）"],
  [2560, "2560 px"],
  [1920, "1920 px（全高清）"],
  [1280, "1280 px"],
  [800, "800 px"],
] as const;

const FORMAT_LABELS: Record<SupportedImageFormat, string> = {
  jpeg: "JPEG",
  png: "PNG",
  webp: "WebP",
};

const STATUS_LABELS: Record<ItemStatus, string> = {
  queued: "等待处理",
  processing: "处理中",
  done: "已完成",
  error: "处理失败",
};

const initialFeedback: Feedback = {
  kind: "idle",
  message: "本地引擎待命。图片只存在当前标签页，不会上传到服务器。",
};

function triggerDownload(url: string, name: string): void {
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
}

function makeUniqueNames(names: readonly string[]): string[] {
  const used = new Set<string>();
  return names.map((name) => {
    let candidate = name;
    let index = 2;
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const extension = dot > 0 ? name.slice(dot) : "";
    while (used.has(candidate.normalize("NFC").toLocaleLowerCase("en-US"))) {
      candidate = `${stem}-${index}${extension}`;
      index += 1;
    }
    used.add(candidate.normalize("NFC").toLocaleLowerCase("en-US"));
    return candidate;
  });
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  mimeType: string,
  quality: number,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error("浏览器未能生成压缩图片。"));
          return;
        }
        if (blob.type !== mimeType) {
          reject(
            new Error(
              `当前浏览器不支持 ${mimeType === "image/webp" ? "WebP" : "JPEG"} 编码。`,
            ),
          );
          return;
        }
        resolve(blob);
      },
      mimeType,
      quality,
    );
  });
}

async function decodeImage(
  file: File,
  sourceUrl: string,
): Promise<DecodedImage> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file, {
        imageOrientation: "from-image",
      });
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        close: () => bitmap.close(),
      };
    } catch {
      // Safari and a few older engines need the HTMLImageElement fallback.
    }
  }

  const image = new Image();
  image.decoding = "async";
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("浏览器无法解码这张图片。"));
    image.src = sourceUrl;
  });
  return {
    source: image,
    width: image.naturalWidth,
    height: image.naturalHeight,
    close: () => {
      image.src = "";
    },
  };
}

export default function ImageCompressorTool() {
  const titleId = useId();
  const inputId = useId();
  const dropHelpId = useId();
  const feedbackId = useId();
  const settingsTitleId = useId();
  const qualityId = useId();
  const formatId = useId();
  const edgeId = useId();
  const backgroundId = useId();

  const [items, setItems] = useState<ImageItem[]>([]);
  const [quality, setQuality] = useState(82);
  const [outputFormat, setOutputFormat] =
    useState<ImageOutputFormat>("original");
  const [maximumEdge, setMaximumEdge] = useState(0);
  const [jpegBackground, setJpegBackground] = useState("#ffffff");
  const [feedback, setFeedback] = useState<Feedback>(initialFeedback);
  const [isDragging, setIsDragging] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isBuildingZip, setIsBuildingZip] = useState(false);
  const [memoryLimits, setMemoryLimits] = useState(() =>
    getImageMemoryLimits(),
  );
  const [resultsStale, setResultsStale] = useState(false);
  const [progress, setProgress] = useState(0);

  const itemsRef = useRef<ImageItem[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const objectUrlsRef = useRef(new Set<string>());
  const workerRef = useRef<Worker | null>(null);
  const pendingPngRef = useRef(new Map<number, PendingPngTask>());
  const nextWorkerIdRef = useRef(0);
  const nextItemIdRef = useRef(0);
  const mountedRef = useRef(false);

  const applyItems = useCallback(
    (updater: (current: ImageItem[]) => ImageItem[]) => {
      const next = updater(itemsRef.current);
      itemsRef.current = next;
      setItems(next);
    },
    [],
  );

  const createTrackedUrl = useCallback((blob: Blob): string => {
    const url = URL.createObjectURL(blob);
    objectUrlsRef.current.add(url);
    return url;
  }, []);

  const revokeTrackedUrl = useCallback((url?: string): void => {
    if (!url || !objectUrlsRef.current.has(url)) return;
    URL.revokeObjectURL(url);
    objectUrlsRef.current.delete(url);
  }, []);

  const rejectPendingPngTasks = useCallback((error: Error): void => {
    for (const task of pendingPngRef.current.values()) {
      window.clearTimeout(task.timeout);
      task.reject(error);
    }
    pendingPngRef.current.clear();
  }, []);

  const ensurePngWorker = useCallback((): Worker => {
    if (workerRef.current) return workerRef.current;

    const worker = new Worker(
      new URL("../../workers/image-compressor.worker.ts", import.meta.url),
      { type: "module", name: "local-png-encoder" },
    );
    worker.onmessage = (event: MessageEvent<PngWorkerResponse>) => {
      const task = pendingPngRef.current.get(event.data.id);
      if (!task) return;
      pendingPngRef.current.delete(event.data.id);
      window.clearTimeout(task.timeout);
      if (event.data.ok) task.resolve(event.data.png);
      else task.reject(new Error(event.data.error));
    };
    worker.onerror = () => {
      rejectPendingPngTasks(new Error("PNG 压缩线程意外停止，请重试。"));
      worker.terminate();
      if (workerRef.current === worker) workerRef.current = null;
    };
    workerRef.current = worker;
    return worker;
  }, [rejectPendingPngTasks]);

  useEffect(() => {
    const objectUrls = objectUrlsRef.current;
    mountedRef.current = true;
    const browserNavigator = navigator as Navigator & {
      deviceMemory?: number;
    };
    const detectedMemoryLimits = getImageMemoryLimits({
      deviceMemoryGiB: browserNavigator.deviceMemory,
      coarsePointer: window.matchMedia?.("(pointer: coarse)").matches ?? false,
    });
    setMemoryLimits(detectedMemoryLimits);
    if (detectedMemoryLimits.defaultMaximumEdge > 0) {
      setMaximumEdge((current) =>
        current === 0 ? detectedMemoryLimits.defaultMaximumEdge : current,
      );
      setFeedback((current) =>
        current.message === initialFeedback.message
          ? {
              kind: "idle",
              message: `已启用移动端内存保护，默认最长边 ${detectedMemoryLimits.defaultMaximumEdge} px；可在高级设置调整。`,
            }
          : current,
      );
    }
    ensurePngWorker();
    return () => {
      mountedRef.current = false;
      workerRef.current?.terminate();
      workerRef.current = null;
      rejectPendingPngTasks(new Error("页面已关闭。"));
      for (const url of objectUrls) URL.revokeObjectURL(url);
      objectUrls.clear();
    };
  }, [ensurePngWorker, rejectPendingPngTasks]);

  const encodePng = useCallback(
    (
      rgba: ArrayBuffer,
      width: number,
      height: number,
      colorCount: number,
    ): Promise<ArrayBuffer> => {
      const worker = ensurePngWorker();
      const id = nextWorkerIdRef.current;
      nextWorkerIdRef.current += 1;
      return new Promise((resolve, reject) => {
        const timeout = window.setTimeout(() => {
          pendingPngRef.current.delete(id);
          reject(new Error("PNG 压缩超时，请尝试更小的图片或降低最长边。"));
        }, 120_000);
        pendingPngRef.current.set(id, { resolve, reject, timeout });
        worker.postMessage({ id, rgba, width, height, colorCount }, [rgba]);
      });
    },
    [ensurePngWorker],
  );

  const completedItems = useMemo(
    () => items.filter((item) => item.status === "done" && item.resultBlob),
    [items],
  );
  const originalTotal = useMemo(
    () => items.reduce((total, item) => total + item.file.size, 0),
    [items],
  );
  const resultTotal = useMemo(
    () =>
      completedItems.reduce(
        (total, item) => total + (item.resultBlob?.size ?? 0),
        0,
      ),
    [completedItems],
  );
  const completedOriginalTotal = useMemo(
    () => completedItems.reduce((total, item) => total + item.file.size, 0),
    [completedItems],
  );
  const failedCount = useMemo(
    () => items.filter((item) => item.status === "error").length,
    [items],
  );

  function resetResults(): void {
    applyItems((current) =>
      current.map((item) => {
        revokeTrackedUrl(item.resultUrl);
        return {
          ...item,
          status: "queued",
          resultBlob: undefined,
          resultUrl: undefined,
          resultName: undefined,
          resultFormat: undefined,
          resultWidth: undefined,
          resultHeight: undefined,
          keptOriginal: undefined,
          memoryLimited: undefined,
          error: undefined,
        };
      }),
    );
    setResultsStale(false);
  }

  function markSettingsChanged(): void {
    const hasProcessedItems = itemsRef.current.some(
      (item) => item.resultBlob || item.status === "error",
    );
    const hasDownloadableResults = itemsRef.current.some(
      (item) => item.resultBlob,
    );
    if (hasProcessedItems) {
      setResultsStale(true);
      setFeedback({
        kind: "idle",
        message: hasDownloadableResults
          ? "参数已更新；当前结果仍可下载，重新压缩后才会替换。"
          : "参数已更新；请重新压缩以生成新结果。",
      });
    }
  }

  async function addFiles(selectedFiles: readonly File[]): Promise<void> {
    if (isProcessing || selectedFiles.length === 0) return;

    const validation = validateImageQueue([
      ...itemsRef.current.map(({ file }) => ({
        name: file.name,
        size: file.size,
      })),
      ...selectedFiles.map(({ name, size }) => ({ name, size })),
    ]);
    if (!validation.ok) {
      setFeedback({ kind: "error", message: validation.error.message.trim() });
      return;
    }

    const accepted: ImageItem[] = [];
    const rejected: string[] = [];
    for (const file of selectedFiles) {
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const inspection = inspectImageData(bytes);
        if (!inspection.ok) throw new Error(inspection.error.message);
        if (inspection.value.animated) {
          throw new Error(
            `${file.name} 是动画 ${inspection.value.format === "png" ? "PNG" : "WebP"}，为避免丢失帧暂不处理。`,
          );
        }
        const dimensions = readImageDimensions(bytes, inspection.value.format);
        if (!dimensions.ok) throw new Error(dimensions.error.message);
        const memoryValidation = validateImageSourceMemory(
          dimensions.value.width,
          dimensions.value.height,
          memoryLimits,
        );
        if (!memoryValidation.ok) {
          throw new Error(memoryValidation.error.message);
        }
        if (!mountedRef.current) return;

        accepted.push({
          id: `${Date.now()}-${nextItemIdRef.current++}`,
          file,
          format: inspection.value.format,
          width: dimensions.value.width,
          height: dimensions.value.height,
          sourceUrl: createTrackedUrl(file),
          status: "queued",
        });
      } catch (error) {
        rejected.push(
          error instanceof Error
            ? error.message
            : `${file.name} 无法读取或不是有效图片。`,
        );
      }
    }

    if (accepted.length > 0) applyItems((current) => [...current, ...accepted]);
    if (rejected.length > 0) {
      const firstErrors = rejected.slice(0, 3).join("；");
      setFeedback({
        kind: "error",
        message: `${accepted.length ? `已添加 ${accepted.length} 张。` : "未添加图片。"}${firstErrors}${rejected.length > 3 ? `；另有 ${rejected.length - 3} 个文件未加入。` : ""}`,
      });
    } else {
      setFeedback({
        kind: "idle",
        message: `已添加 ${accepted.length} 张图片，共 ${formatBytes(accepted.reduce((sum, item) => sum + item.file.size, 0))}。`,
      });
    }
  }

  function handleDrop(event: DragEvent<HTMLLabelElement>): void {
    event.preventDefault();
    setIsDragging(false);
    if (!isProcessing) void addFiles(Array.from(event.dataTransfer.files));
  }

  async function compressItem(
    item: ImageItem,
    settings: CompressionSettings,
  ): Promise<Omit<ImageItem, "sourceUrl" | "id" | "file" | "format">> {
    const decoded = await decodeImage(item.file, item.sourceUrl);
    let canvas: HTMLCanvasElement | undefined;
    try {
      const dimensionValidation = validateImageSourceMemory(
        decoded.width,
        decoded.height,
        settings.memoryLimits,
      );
      if (!dimensionValidation.ok) {
        throw new Error(dimensionValidation.error.message);
      }

      const targetFormat = resolveOutputFormat(
        item.format,
        settings.outputFormat,
      );
      const size = calculateMemorySafeSize(
        decoded.width,
        decoded.height,
        settings.maximumEdge,
        targetFormat,
        settings.memoryLimits,
      );
      const descriptor = getImageFormatDescriptor(targetFormat);

      canvas = document.createElement("canvas");
      canvas.width = size.width;
      canvas.height = size.height;
      const context = canvas.getContext("2d", {
        alpha: true,
        willReadFrequently: targetFormat === "png",
      });
      if (!context) throw new Error("当前浏览器无法创建图片处理画布。");
      context.drawImage(decoded.source, 0, 0, size.width, size.height);

      let candidate: Blob;
      if (targetFormat === "png") {
        const pixels = context.getImageData(0, 0, size.width, size.height);
        const png = await encodePng(
          pixels.data.buffer,
          size.width,
          size.height,
          qualityToPngPaletteColors(settings.quality),
        );
        candidate = new Blob([png], { type: descriptor.mimeType });
      } else {
        if (targetFormat === "jpeg") {
          context.globalCompositeOperation = "destination-over";
          context.fillStyle = settings.jpegBackground;
          context.fillRect(0, 0, size.width, size.height);
          context.globalCompositeOperation = "source-over";
        }
        candidate = await canvasToBlob(
          canvas,
          descriptor.mimeType,
          settings.quality / 100,
        );
      }

      const keepOriginal =
        settings.outputFormat === "original" &&
        settings.maximumEdge === 0 &&
        !size.memoryLimited &&
        candidate.size >= item.file.size;
      const resultBlob = keepOriginal ? item.file : candidate;
      const resultName = createOutputFileName(
        item.file.name,
        keepOriginal ? item.format : targetFormat,
        keepOriginal ? "original" : "compressed",
      );
      if (!mountedRef.current) throw new Error("页面已关闭。");
      return {
        width: item.width,
        height: item.height,
        status: "done",
        resultBlob,
        resultUrl: createTrackedUrl(resultBlob),
        resultName,
        resultFormat: keepOriginal ? item.format : targetFormat,
        resultWidth: keepOriginal ? item.width : size.width,
        resultHeight: keepOriginal ? item.height : size.height,
        keptOriginal: keepOriginal,
        memoryLimited: size.memoryLimited,
      };
    } finally {
      decoded.close();
      if (canvas) {
        canvas.width = 0;
        canvas.height = 0;
      }
    }
  }

  async function compressAll(): Promise<void> {
    if (isProcessing || itemsRef.current.length === 0) return;
    resetResults();
    setIsProcessing(true);
    setProgress(0);
    setFeedback({ kind: "idle", message: "正在浏览器本地串行压缩图片…" });
    const settings: CompressionSettings = {
      quality,
      outputFormat,
      maximumEdge,
      jpegBackground,
      memoryLimits,
    };
    const queue = [...itemsRef.current];
    let succeeded = 0;
    let failed = 0;
    let memoryLimitedCount = 0;
    let storedResultBytes = 0;

    for (const [index, queuedItem] of queue.entries()) {
      if (!mountedRef.current) return;
      applyItems((current) =>
        current.map((item) =>
          item.id === queuedItem.id ? { ...item, status: "processing" } : item,
        ),
      );
      try {
        const result = await compressItem(queuedItem, settings);
        if (!mountedRef.current) return;
        const nextResultBytes = result.resultBlob?.size ?? 0;
        if (
          storedResultBytes >
          settings.memoryLimits.maxResultBytes - nextResultBytes
        ) {
          revokeTrackedUrl(result.resultUrl);
          throw new Error(
            `本批结果超过当前设备 ${formatBytes(settings.memoryLimits.maxResultBytes)} 的内存安全上限。请先下载并移除已完成图片，再分批处理。`,
          );
        }
        applyItems((current) =>
          current.map((item) =>
            item.id === queuedItem.id ? { ...item, ...result } : item,
          ),
        );
        storedResultBytes += nextResultBytes;
        if (result.memoryLimited) memoryLimitedCount += 1;
        succeeded += 1;
      } catch (error) {
        failed += 1;
        applyItems((current) =>
          current.map((item) =>
            item.id === queuedItem.id
              ? {
                  ...item,
                  status: "error",
                  error:
                    error instanceof Error ? error.message : "图片压缩失败。",
                }
              : item,
          ),
        );
      }
      setProgress(index + 1);
    }

    if (!mountedRef.current) return;
    setIsProcessing(false);
    setFeedback({
      kind: failed === 0 ? "success" : succeeded > 0 ? "warning" : "error",
      message: failed
        ? `已完成 ${succeeded} 张，${failed} 张处理失败，请查看列表。`
        : `已完成 ${succeeded} 张图片${memoryLimitedCount > 0 ? `；其中 ${memoryLimitedCount} 张按内存安全上限自动缩小` : ""}；结果仍只保存在当前标签页。`,
    });
  }

  function removeItem(id: string): void {
    applyItems((current) => {
      const target = current.find((item) => item.id === id);
      revokeTrackedUrl(target?.sourceUrl);
      revokeTrackedUrl(target?.resultUrl);
      const nextItems = current.filter((item) => item.id !== id);
      if (
        !nextItems.some((item) => item.resultBlob || item.status === "error")
      ) {
        setResultsStale(false);
      }
      return nextItems;
    });
    setFeedback({ kind: "idle", message: "图片已从本地处理列表移除。" });
  }

  function clearItems(): void {
    for (const item of itemsRef.current) {
      revokeTrackedUrl(item.sourceUrl);
      revokeTrackedUrl(item.resultUrl);
    }
    applyItems(() => []);
    setResultsStale(false);
    setProgress(0);
    setFeedback({ kind: "idle", message: "图片列表与本地结果已清空。" });
  }

  async function downloadZip(): Promise<void> {
    if (isBuildingZip || completedItems.length === 0) return;
    setIsBuildingZip(true);
    try {
      if (resultTotal > memoryLimits.maxZipBytes) {
        throw new Error(
          `结果总计 ${formatBytes(resultTotal)}，超过当前设备 ${formatBytes(memoryLimits.maxZipBytes)} 的 ZIP 内存安全上限。请改为逐张下载。`,
        );
      }
      const names = makeUniqueNames(
        completedItems.map((item) => item.resultName ?? "compressed-image"),
      );
      const entries = [];
      for (const [index, item] of completedItems.entries()) {
        entries.push({
          name: names[index]!,
          data: new Uint8Array(await item.resultBlob!.arrayBuffer()),
        });
      }
      const archive = createStoreZip(entries);
      const url = URL.createObjectURL(
        new Blob([archive.buffer as ArrayBuffer], { type: "application/zip" }),
      );
      triggerDownload(url, "compressed-images.zip");
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
      setFeedback({
        kind: "success",
        message: `已在本地打包并下载 ${completedItems.length} 张图片。`,
      });
    } catch (error) {
      setFeedback({
        kind: "error",
        message: error instanceof Error ? error.message : "ZIP 打包失败。",
      });
    } finally {
      setIsBuildingZip(false);
    }
  }

  return (
    <ToolWorkspace
      toolId="image-compressor"
      titleId={titleId}
      className="image-compressor-tool"
    >
      <ToolWorkspaceHeader className="image-compressor-tool__heading">
        <div className="image-compressor-tool__heading-copy">
          <p className="eyebrow">图片工作区</p>
          <h2 id={titleId}>压缩设置与结果</h2>
          <p>添加图片、调整参数，然后在本地生成并下载结果。</p>
        </div>
      </ToolWorkspaceHeader>

      <input
        ref={inputRef}
        id={inputId}
        className="image-compressor-tool__file-input"
        type="file"
        multiple
        accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
        aria-label="选择 JPEG、PNG 或 WebP 图片"
        aria-describedby={`${dropHelpId} ${feedbackId}`}
        disabled={isProcessing}
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = "";
          void addFiles(files);
        }}
        data-privacy-canary-input
      />
      <label
        htmlFor={inputId}
        className={`image-compressor-tool__dropzone${isDragging ? " is-dragging" : ""}${isProcessing ? " is-disabled" : ""}${items.length > 0 ? " has-files" : ""}`}
        onDragEnter={(event) => {
          event.preventDefault();
          if (!isProcessing) setIsDragging(true);
        }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={(event) => {
          if (
            !event.currentTarget.contains(event.relatedTarget as Node | null)
          ) {
            setIsDragging(false);
          }
        }}
        onDrop={handleDrop}
        data-tool-region="input"
        data-tool-action="upload"
      >
        <span className="image-compressor-tool__drop-icon" aria-hidden="true">
          <svg viewBox="0 0 48 48">
            <rect x="7" y="9" width="34" height="30" rx="7" />
            <circle cx="17" cy="19" r="3" />
            <path d="m11 34 9-9 6 6 4-4 7 7M24 4v13m-5-5 5 5 5-5" />
          </svg>
        </span>
        <div className="image-compressor-tool__drop-copy">
          <span>本地图片处理</span>
          <strong>
            {items.length > 0 ? "继续添加图片" : "拖入图片，开始压缩"}
          </strong>
          <p id={dropHelpId}>
            支持 JPEG、PNG、WebP；最多 {MAX_IMAGE_FILES} 张，总计不超过 100 MiB
            ；当前单图解码上限 {memoryLimits.maxSourcePixels / 1_000_000} MP
          </p>
          <div
            className="image-compressor-tool__format-tags"
            aria-hidden="true"
          >
            <span>JPEG</span>
            <span>PNG</span>
            <span>WEBP</span>
          </div>
        </div>
        <span className="image-compressor-tool__browse-cue" aria-hidden="true">
          浏览文件 <b>↗</b>
        </span>
      </label>

      <div className="image-compressor-tool__control-grid">
        <section
          className="image-compressor-tool__settings"
          aria-labelledby={settingsTitleId}
        >
          <div className="image-compressor-tool__panel-head">
            <div>
              <span>基础设置</span>
              <h3 id={settingsTitleId}>压缩参数</h3>
            </div>
            <span className="image-compressor-tool__mode-chip">
              {quality < 74
                ? "体积优先"
                : quality < 89
                  ? "均衡模式"
                  : "画质优先"}
            </span>
          </div>

          <div className="image-compressor-tool__settings-primary">
            <div className="image-compressor-tool__quality">
              <div className="image-compressor-tool__label-row">
                <div>
                  <label htmlFor={qualityId}>压缩质量</label>
                  <small>数值越低，输出文件通常越小</small>
                </div>
                <output htmlFor={qualityId}>{quality}%</output>
              </div>
              <input
                id={qualityId}
                type="range"
                min="30"
                max="100"
                step="1"
                value={quality}
                disabled={isProcessing}
                aria-valuetext={`${quality}%`}
                style={{ "--quality": `${quality}%` } as CSSProperties}
                onChange={(event) => {
                  setQuality(Number(event.currentTarget.value));
                  markSettingsChanged();
                }}
              />
              <div
                className="image-compressor-tool__presets"
                aria-label="质量预设"
                role="group"
              >
                {QUALITY_PRESETS.map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={quality === value}
                    disabled={isProcessing}
                    onClick={() => {
                      setQuality(value);
                      markSettingsChanged();
                    }}
                  >
                    <span>{label}</span>
                    <strong>{value}%</strong>
                  </button>
                ))}
              </div>
            </div>

            <label className="image-compressor-tool__select" htmlFor={formatId}>
              <span>输出格式</span>
              <small>默认保留原格式，避免无意义转换</small>
              <select
                id={formatId}
                value={outputFormat}
                disabled={isProcessing}
                onChange={(event) => {
                  setOutputFormat(
                    event.currentTarget.value as ImageOutputFormat,
                  );
                  markSettingsChanged();
                }}
              >
                {OUTPUT_FORMATS.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <details className="image-compressor-tool__advanced">
            <summary>
              <span>
                <strong>高级设置</strong>
                <small>
                  尺寸限制{outputFormat === "jpeg" ? "与透明背景" : ""}
                  ，必要时自动启用内存保护
                </small>
              </span>
              <b aria-hidden="true">＋</b>
            </summary>
            <div className="image-compressor-tool__advanced-grid">
              <label className="image-compressor-tool__select" htmlFor={edgeId}>
                <span>最长边</span>
                <small>等比例缩放，不会拉伸图片</small>
                <select
                  id={edgeId}
                  value={maximumEdge}
                  disabled={isProcessing}
                  onChange={(event) => {
                    setMaximumEdge(Number(event.currentTarget.value));
                    markSettingsChanged();
                  }}
                >
                  {MAXIMUM_EDGES.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>

              {outputFormat === "jpeg" && (
                <label
                  className="image-compressor-tool__color"
                  htmlFor={backgroundId}
                >
                  <span>JPEG 透明背景</span>
                  <small>透明区域会填充为所选颜色</small>
                  <span className="image-compressor-tool__color-control">
                    <input
                      id={backgroundId}
                      type="color"
                      value={jpegBackground}
                      disabled={isProcessing}
                      onChange={(event) => {
                        setJpegBackground(event.currentTarget.value);
                        markSettingsChanged();
                      }}
                    />
                    <code>{jpegBackground.toUpperCase()}</code>
                  </span>
                </label>
              )}
            </div>
          </details>
        </section>

        <div
          className={`image-compressor-tool__command-bar${resultsStale ? " has-stale-results" : ""}`}
        >
          <div
            id={feedbackId}
            className={`image-compressor-tool__feedback image-compressor-tool__feedback--${feedback.kind}`}
            role="status"
            aria-live={feedback.kind === "error" ? "assertive" : "polite"}
            aria-atomic="true"
          >
            <span aria-hidden="true" />
            <div>
              <strong>
                {feedback.kind === "error"
                  ? "需要检查"
                  : feedback.kind === "warning"
                    ? "部分完成"
                    : feedback.kind === "success"
                      ? "处理完成"
                      : resultsStale
                        ? "参数已更新"
                        : isProcessing
                          ? "本地引擎运行中"
                          : "本地引擎待命"}
              </strong>
              <p>{feedback.message}</p>
              <p className="image-compressor-tool__zip-limit">
                本设备 ZIP 上限 {formatBytes(memoryLimits.maxZipBytes)}
                ；超出时请逐张下载。
              </p>
            </div>
          </div>

          <div
            className="image-compressor-tool__actions"
            data-tool-region="actions"
          >
            <button
              className="button button--primary"
              type="button"
              disabled={items.length === 0 || isProcessing}
              onClick={() => void compressAll()}
              data-privacy-canary-action
              data-tool-action="execute"
            >
              <span aria-hidden="true">◇</span>
              {isProcessing
                ? `正在压缩 ${progress}/${items.length}`
                : resultsStale
                  ? `重新压缩 ${items.length} 张图片`
                  : items.length > 0
                    ? `压缩 ${items.length} 张图片`
                    : "添加图片后开始压缩"}
            </button>
            <button
              className="button button--secondary"
              type="button"
              disabled={
                completedItems.length === 0 || isProcessing || isBuildingZip
              }
              onClick={() => void downloadZip()}
              title={`ZIP 打包上限 ${formatBytes(memoryLimits.maxZipBytes)}；超过后请逐张下载`}
              data-tool-action="download"
            >
              {isBuildingZip ? "正在打包…" : "下载全部 ZIP"}
            </button>
            <button
              className="button button--quiet"
              type="button"
              disabled={items.length === 0 || isProcessing}
              onClick={clearItems}
              data-tool-action="clear"
            >
              清空
            </button>
          </div>
        </div>
      </div>

      {items.length > 0 && (
        <section
          className="image-compressor-tool__metrics"
          aria-label="处理概览"
        >
          <div>
            <span>任务</span>
            <strong>{items.length}</strong>
            <small>张图片</small>
          </div>
          <div>
            <span>原始体积</span>
            <strong>{formatBytes(originalTotal)}</strong>
            <small>本地输入</small>
          </div>
          <div>
            <span>输出体积</span>
            <strong>
              {completedItems.length > 0 ? formatBytes(resultTotal) : "—"}
            </strong>
            <small>
              {completedItems.length > 0
                ? `${completedItems.length} 张已完成`
                : "等待处理"}
            </small>
          </div>
          <div className="image-compressor-tool__metric-saving">
            <span>空间变化</span>
            <strong>
              {completedItems.length > 0
                ? formatSavings(completedOriginalTotal, resultTotal)
                : "—"}
            </strong>
            <small>相对已完成原图</small>
          </div>
        </section>
      )}

      {items.length > 0 && (
        <div
          className="image-compressor-tool__queue"
          aria-busy={isProcessing}
          data-tool-region="output"
        >
          <div className="image-compressor-tool__queue-head">
            <div>
              <span>处理结果</span>
              <h3>图片队列</h3>
            </div>
            {isProcessing ? (
              <div className="image-compressor-tool__progress">
                <span>
                  正在处理 {progress} / {items.length}
                </span>
                <progress
                  aria-label="批量压缩进度"
                  max={items.length}
                  value={progress}
                />
              </div>
            ) : (
              <span className="image-compressor-tool__queue-state">
                {failedCount > 0
                  ? completedItems.length > 0
                    ? `${completedItems.length} 完成 · ${failedCount} 失败`
                    : `${failedCount} 个任务处理失败`
                  : completedItems.length > 0
                    ? `${completedItems.length} / ${items.length} 已完成`
                    : `${items.length} 个任务待处理`}
              </span>
            )}
          </div>

          <ul
            className="image-compressor-tool__items"
            aria-label="图片处理结果"
          >
            {items.map((item) => {
              const resultSize = item.resultBlob?.size;
              return (
                <li
                  key={item.id}
                  className="image-compressor-tool__item"
                  data-status={item.status}
                >
                  <div className="image-compressor-tool__item-preview">
                    <img
                      src={item.resultUrl ?? item.sourceUrl}
                      alt={`${item.file.name} 的预览`}
                      loading="lazy"
                    />
                    <span>
                      {FORMAT_LABELS[item.resultFormat ?? item.format]}
                    </span>
                  </div>
                  <div className="image-compressor-tool__item-copy">
                    <div className="image-compressor-tool__item-head">
                      <strong title={item.file.name}>{item.file.name}</strong>
                      <span
                        className={`image-compressor-tool__status image-compressor-tool__status--${item.status}`}
                      >
                        {STATUS_LABELS[item.status]}
                      </span>
                    </div>
                    <p className="image-compressor-tool__source-meta">
                      原始尺寸 {item.width} × {item.height} PX
                    </p>
                    {item.status === "done" && resultSize !== undefined && (
                      <div className="image-compressor-tool__size-flow">
                        <div>
                          <span>原图</span>
                          <strong>{formatBytes(item.file.size)}</strong>
                        </div>
                        <b aria-hidden="true">→</b>
                        <div>
                          <span>
                            输出 · {item.resultWidth} × {item.resultHeight}
                          </span>
                          <strong>{formatBytes(resultSize)}</strong>
                        </div>
                        <em>
                          {item.keptOriginal
                            ? "已保留原图"
                            : formatSavings(item.file.size, resultSize)}
                        </em>
                      </div>
                    )}
                    {item.status === "done" && item.memoryLimited && (
                      <p className="image-compressor-tool__status-copy">
                        为控制峰值内存，已按当前设备安全上限自动缩小输出尺寸。
                      </p>
                    )}
                    {item.status === "processing" && (
                      <p className="image-compressor-tool__status-copy">
                        正在读取像素并写入本地输出…
                      </p>
                    )}
                    {item.status === "queued" && (
                      <p className="image-compressor-tool__status-copy">
                        已就绪，等待本地引擎处理
                      </p>
                    )}
                    {item.status === "error" && (
                      <p className="image-compressor-tool__item-error">
                        {item.error}
                      </p>
                    )}
                  </div>
                  <div className="image-compressor-tool__item-actions">
                    {item.status === "done" &&
                      item.resultUrl &&
                      item.resultName && (
                        <button
                          className="button button--secondary"
                          type="button"
                          onClick={() =>
                            triggerDownload(item.resultUrl!, item.resultName!)
                          }
                          aria-label={`下载 ${item.resultName}`}
                          data-tool-action="download"
                        >
                          <span aria-hidden="true">↓</span> 下载
                        </button>
                      )}
                    <button
                      className="button button--quiet"
                      type="button"
                      disabled={isProcessing}
                      onClick={() => removeItem(item.id)}
                      aria-label={`移除 ${item.file.name}`}
                      data-tool-action="clear"
                    >
                      <span aria-hidden="true">×</span> 移除
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </ToolWorkspace>
  );
}

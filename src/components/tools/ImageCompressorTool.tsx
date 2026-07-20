import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
} from "react";

import {
  MAX_IMAGE_FILES,
  calculateContainSize,
  createOutputFileName,
  createStoreZip,
  formatBytes,
  formatSavings,
  getImageFormatDescriptor,
  inspectImageData,
  qualityToPngPaletteColors,
  readImageDimensions,
  resolveOutputFormat,
  validateImageDimensions,
  validateImageQueue,
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
  resultWidth?: number;
  resultHeight?: number;
  keptOriginal?: boolean;
  error?: string;
}

interface CompressionSettings {
  quality: number;
  outputFormat: ImageOutputFormat;
  maximumEdge: number;
  jpegBackground: string;
}

type Feedback = {
  kind: "idle" | "success" | "error";
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

const initialFeedback: Feedback = {
  kind: "idle",
  message: "图片只在当前浏览器中处理，不会上传、保存或发送到服务器。",
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

  function discardResults(): void {
    const hadResults = itemsRef.current.some(
      (item) => item.resultBlob || item.status === "error",
    );
    applyItems((current) =>
      current.map((item) => {
        revokeTrackedUrl(item.resultUrl);
        return {
          ...item,
          status: "queued",
          resultBlob: undefined,
          resultUrl: undefined,
          resultName: undefined,
          resultWidth: undefined,
          resultHeight: undefined,
          keptOriginal: undefined,
          error: undefined,
        };
      }),
    );
    if (hadResults) {
      setFeedback({
        kind: "idle",
        message: "压缩设置已更新，请重新压缩列表中的图片。",
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

  function handleDrop(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault();
    setIsDragging(false);
    if (!isProcessing) void addFiles(Array.from(event.dataTransfer.files));
  }

  function openFilePicker(event: KeyboardEvent<HTMLDivElement>): void {
    if (isProcessing) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      inputRef.current?.click();
    }
  }

  async function compressItem(
    item: ImageItem,
    settings: CompressionSettings,
  ): Promise<Omit<ImageItem, "sourceUrl" | "id" | "file" | "format">> {
    const decoded = await decodeImage(item.file, item.sourceUrl);
    let canvas: HTMLCanvasElement | undefined;
    try {
      const dimensionValidation = validateImageDimensions(
        decoded.width,
        decoded.height,
      );
      if (!dimensionValidation.ok) {
        throw new Error(dimensionValidation.error.message);
      }

      const size =
        settings.maximumEdge > 0
          ? calculateContainSize(
              decoded.width,
              decoded.height,
              settings.maximumEdge,
            )
          : {
              width: decoded.width,
              height: decoded.height,
              scale: 1,
              resized: false,
            };
      const targetFormat = resolveOutputFormat(
        item.format,
        settings.outputFormat,
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
        resultWidth: keepOriginal ? item.width : size.width,
        resultHeight: keepOriginal ? item.height : size.height,
        keptOriginal: keepOriginal,
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
    discardResults();
    setIsProcessing(true);
    setProgress(0);
    setFeedback({ kind: "idle", message: "正在浏览器本地串行压缩图片…" });
    const settings: CompressionSettings = {
      quality,
      outputFormat,
      maximumEdge,
      jpegBackground,
    };
    const queue = [...itemsRef.current];
    let succeeded = 0;
    let failed = 0;

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
        applyItems((current) =>
          current.map((item) =>
            item.id === queuedItem.id ? { ...item, ...result } : item,
          ),
        );
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
      kind: succeeded ? "success" : "error",
      message: failed
        ? `已完成 ${succeeded} 张，${failed} 张处理失败，请查看列表。`
        : `已完成 ${succeeded} 张图片；结果仍只保存在当前标签页。`,
    });
  }

  function removeItem(id: string): void {
    applyItems((current) => {
      const target = current.find((item) => item.id === id);
      revokeTrackedUrl(target?.sourceUrl);
      revokeTrackedUrl(target?.resultUrl);
      return current.filter((item) => item.id !== id);
    });
    setFeedback({ kind: "idle", message: "图片已从本地处理列表移除。" });
  }

  function clearItems(): void {
    for (const item of itemsRef.current) {
      revokeTrackedUrl(item.sourceUrl);
      revokeTrackedUrl(item.resultUrl);
    }
    applyItems(() => []);
    setProgress(0);
    setFeedback({ kind: "idle", message: "图片列表与本地结果已清空。" });
  }

  async function downloadZip(): Promise<void> {
    if (isBuildingZip || completedItems.length === 0) return;
    setIsBuildingZip(true);
    try {
      const names = makeUniqueNames(
        completedItems.map((item) => item.resultName ?? "compressed-image"),
      );
      const entries = await Promise.all(
        completedItems.map(async (item, index) => ({
          name: names[index]!,
          data: new Uint8Array(await item.resultBlob!.arrayBuffer()),
        })),
      );
      const archive = createStoreZip(entries);
      const archiveBuffer = archive.buffer.slice(
        archive.byteOffset,
        archive.byteOffset + archive.byteLength,
      ) as ArrayBuffer;
      const url = URL.createObjectURL(
        new Blob([archiveBuffer], { type: "application/zip" }),
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
    <section
      className="tool-workspace image-compressor-tool"
      aria-labelledby={titleId}
      data-local-processing="true"
    >
      <div className="tool-workspace__head image-compressor-tool__heading">
        <div>
          <p className="eyebrow">交互区域</p>
          <h2 id={titleId}>图片压缩与格式转换</h2>
        </div>
        <span className="limit-label">最多 20 张 · 单张 20 MiB</span>
      </div>

      <aside
        className="image-compressor-tool__privacy"
        aria-label="本地处理说明"
      >
        <span aria-hidden="true">✓</span>
        <p>
          <strong>全程本地处理。</strong>图片不会离开浏览器；动画 PNG / WebP
          会被拒绝，重新编码通常会移除 EXIF 等元数据。
        </p>
      </aside>

      <div
        className={`image-compressor-tool__dropzone${isDragging ? " is-dragging" : ""}${isProcessing ? " is-disabled" : ""}`}
        role="button"
        tabIndex={isProcessing ? -1 : 0}
        aria-disabled={isProcessing}
        aria-describedby={`${dropHelpId} ${feedbackId}`}
        onClick={() => !isProcessing && inputRef.current?.click()}
        onKeyDown={openFilePicker}
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
      >
        <input
          ref={inputRef}
          id={inputId}
          className="image-compressor-tool__file-input"
          type="file"
          multiple
          accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
          aria-label="选择 JPEG、PNG 或 WebP 图片"
          disabled={isProcessing}
          onClick={(event) => event.stopPropagation()}
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? []);
            event.currentTarget.value = "";
            void addFiles(files);
          }}
          data-privacy-canary-input
        />
        <span className="image-compressor-tool__drop-icon" aria-hidden="true">
          IMG
        </span>
        <div>
          <strong>选择图片或拖到这里</strong>
          <p id={dropHelpId}>
            JPEG、PNG、WebP；最多 {MAX_IMAGE_FILES} 张，总计不超过 100 MiB
          </p>
        </div>
      </div>

      <div className="image-compressor-tool__settings" aria-label="压缩设置">
        <div className="image-compressor-tool__quality">
          <div className="image-compressor-tool__label-row">
            <label htmlFor={qualityId}>质量</label>
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
            onChange={(event) => {
              setQuality(Number(event.currentTarget.value));
              discardResults();
            }}
          />
          <div className="image-compressor-tool__presets" aria-label="质量预设">
            {QUALITY_PRESETS.map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={quality === value}
                disabled={isProcessing}
                onClick={() => {
                  setQuality(value);
                  discardResults();
                }}
              >
                {label} {value}%
              </button>
            ))}
          </div>
        </div>

        <label className="image-compressor-tool__select" htmlFor={formatId}>
          <span>输出格式</span>
          <select
            id={formatId}
            value={outputFormat}
            disabled={isProcessing}
            onChange={(event) => {
              setOutputFormat(event.currentTarget.value as ImageOutputFormat);
              discardResults();
            }}
          >
            {OUTPUT_FORMATS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>

        <label className="image-compressor-tool__select" htmlFor={edgeId}>
          <span>最长边</span>
          <select
            id={edgeId}
            value={maximumEdge}
            disabled={isProcessing}
            onChange={(event) => {
              setMaximumEdge(Number(event.currentTarget.value));
              discardResults();
            }}
          >
            {MAXIMUM_EDGES.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>

        <label
          className={`image-compressor-tool__color${outputFormat === "jpeg" ? " is-visible" : ""}`}
          htmlFor={backgroundId}
        >
          <span>JPEG 透明背景</span>
          <span className="image-compressor-tool__color-control">
            <input
              id={backgroundId}
              type="color"
              value={jpegBackground}
              disabled={isProcessing || outputFormat !== "jpeg"}
              onChange={(event) => {
                setJpegBackground(event.currentTarget.value);
                discardResults();
              }}
            />
            <code>{jpegBackground.toUpperCase()}</code>
          </span>
        </label>
      </div>

      <div
        id={feedbackId}
        className={`image-compressor-tool__feedback image-compressor-tool__feedback--${feedback.kind}`}
        role={feedback.kind === "error" ? "alert" : "status"}
        aria-live={feedback.kind === "error" ? "assertive" : "polite"}
        aria-atomic="true"
      >
        <span aria-hidden="true">
          {feedback.kind === "error"
            ? "!"
            : feedback.kind === "success"
              ? "✓"
              : "i"}
        </span>
        <p>{feedback.message}</p>
      </div>

      {items.length > 0 && (
        <div className="image-compressor-tool__queue" aria-busy={isProcessing}>
          <div className="image-compressor-tool__queue-head">
            <div>
              <h3>处理列表</h3>
              <p>
                {items.length} 张 · 原图 {formatBytes(originalTotal)}
                {completedItems.length > 0 &&
                  ` · 结果 ${formatBytes(resultTotal)} · ${formatSavings(
                    completedItems.reduce(
                      (sum, item) => sum + item.file.size,
                      0,
                    ),
                    resultTotal,
                  )}`}
              </p>
            </div>
            {isProcessing && (
              <div className="image-compressor-tool__progress">
                <span>
                  {progress} / {items.length}
                </span>
                <progress
                  aria-label="批量压缩进度"
                  max={items.length}
                  value={progress}
                />
              </div>
            )}
          </div>

          <ul
            className="image-compressor-tool__items"
            aria-label="图片处理结果"
          >
            {items.map((item) => {
              const resultSize = item.resultBlob?.size;
              return (
                <li key={item.id} className="image-compressor-tool__item">
                  <img
                    src={item.resultUrl ?? item.sourceUrl}
                    alt={`${item.file.name} 的预览`}
                    loading="lazy"
                  />
                  <div className="image-compressor-tool__item-copy">
                    <strong title={item.file.name}>{item.file.name}</strong>
                    <p>
                      {FORMAT_LABELS[item.format]} · {item.width} ×{" "}
                      {item.height} · {formatBytes(item.file.size)}
                    </p>
                    {item.status === "done" && resultSize !== undefined && (
                      <p className="image-compressor-tool__result-meta">
                        → {item.resultWidth} × {item.resultHeight} ·{" "}
                        {formatBytes(resultSize)} ·{" "}
                        {item.keptOriginal
                          ? "压缩结果未更小，已保留原图"
                          : formatSavings(item.file.size, resultSize)}
                      </p>
                    )}
                    {item.status === "processing" && <p>正在本地压缩…</p>}
                    {item.status === "queued" && <p>等待压缩</p>}
                    {item.status === "error" && (
                      <p
                        className="image-compressor-tool__item-error"
                        role="alert"
                      >
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
                        >
                          下载
                        </button>
                      )}
                    <button
                      className="button button--quiet"
                      type="button"
                      disabled={isProcessing}
                      onClick={() => removeItem(item.id)}
                      aria-label={`移除 ${item.file.name}`}
                    >
                      移除
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <div className="workspace-actions image-compressor-tool__actions">
        <div>
          <button
            className="button button--primary"
            type="button"
            disabled={items.length === 0 || isProcessing}
            onClick={() => void compressAll()}
            data-privacy-canary-action
          >
            {isProcessing
              ? `正在压缩 ${progress}/${items.length}`
              : `压缩 ${items.length || ""} 张图片`}
          </button>
          <button
            className="button button--secondary"
            type="button"
            disabled={
              completedItems.length === 0 || isProcessing || isBuildingZip
            }
            onClick={() => void downloadZip()}
          >
            {isBuildingZip ? "正在打包…" : "下载全部 ZIP"}
          </button>
        </div>
        <button
          className="button button--quiet"
          type="button"
          disabled={items.length === 0 || isProcessing}
          onClick={clearItems}
        >
          清空列表
        </button>
      </div>
    </section>
  );
}

import {
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import {
  ToolWorkspace,
  ToolWorkspaceAction,
  ToolWorkspaceActions,
  ToolWorkspaceHeader,
  ToolWorkspaceRegion,
} from "../ToolWorkspace";
import {
  getQrTextByteLength,
  QR_CODE_LIMITS,
  QR_DISPLAY_SIZES,
  QR_ECC_BYTE_CAPACITY,
  QR_ERROR_CORRECTION_LEVELS,
  type QrDisplaySize,
  type QrErrorCorrectionLevel,
  type QrGenerateSuccess,
  type QrScanSuccess,
} from "../../tools/qr-code/contract";
import {
  inspectQrImageBytes,
  validateQrImageFileSize,
  type QrImageMetadata,
} from "../../tools/qr-code/image-input";
import {
  QrWorkerClient,
  QrWorkerClientError,
  type QrWorkerTask,
} from "../../tools/qr-code/worker-client";
import { decodeQrImageFile, QrImageDecodeError } from "./qr-image-decoder";

type QrMode = "generate" | "scan";

type Feedback = Readonly<{
  kind: "idle" | "success" | "warning" | "error";
  message: string;
}>;

interface SelectedQrImage {
  readonly file: File;
  readonly metadata: QrImageMetadata;
}

const SAMPLE_TEXT = "Online Tools Hub · 本地二维码 👋";

const ECC_LABELS: Readonly<
  Record<
    QrErrorCorrectionLevel,
    { readonly title: string; readonly detail: string }
  >
> = Object.freeze({
  L: { title: "L · 7%", detail: "容量最大" },
  M: { title: "M · 15%", detail: "日常推荐" },
  Q: { title: "Q · 25%", detail: "更耐遮挡" },
  H: { title: "H · 30%", detail: "容错最高" },
});

const initialFeedback: Feedback = {
  kind: "idle",
  message: "生成与识别都只在当前标签页完成；不会上传、保存或自动打开链接。",
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kibibytes = bytes / 1024;
  if (kibibytes < 1024)
    return `${kibibytes.toFixed(kibibytes < 10 ? 1 : 0)} KiB`;
  return `${(kibibytes / 1024).toFixed(1)} MiB`;
}

function triggerDownload(url: string): void {
  const link = document.createElement("a");
  link.href = url;
  link.download = "qr-code.svg";
  document.body.append(link);
  link.click();
  link.remove();
}

function copyText(value: string): Promise<void> {
  if (!navigator.clipboard?.writeText) {
    return Promise.reject(new Error("Clipboard API unavailable"));
  }
  return navigator.clipboard.writeText(value);
}

function failureFeedback(error: unknown): Feedback {
  if (error instanceof QrWorkerClientError) {
    return {
      kind: error.code === "cancelled" ? "warning" : "error",
      message: error.message,
    };
  }
  if (error instanceof QrImageDecodeError) {
    return {
      kind: error.code === "cancelled" ? "warning" : "error",
      message: error.message,
    };
  }
  return {
    kind: "error",
    message: "二维码任务未能完成，临时 Worker 与像素已释放。",
  };
}

export default function QrCodeTool() {
  const titleId = useId();
  const modeLegendId = useId();
  const textId = useId();
  const textCountId = useId();
  const feedbackId = useId();
  const fileInputId = useId();
  const fileHelpId = useId();
  const resultId = useId();

  const [mode, setMode] = useState<QrMode>("generate");
  const [text, setText] = useState(SAMPLE_TEXT);
  const [ecc, setEcc] = useState<QrErrorCorrectionLevel>("M");
  const [displaySize, setDisplaySize] = useState<QrDisplaySize>(512);
  const [attemptInversion, setAttemptInversion] = useState(true);
  const [selectedImage, setSelectedImage] = useState<SelectedQrImage | null>(
    null,
  );
  const [generateResult, setGenerateResult] =
    useState<QrGenerateSuccess | null>(null);
  const [scanResult, setScanResult] = useState<QrScanSuccess | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(initialFeedback);
  const [running, setRunning] = useState(false);
  const [validatingFile, setValidatingFile] = useState(false);
  const [dragging, setDragging] = useState(false);

  const clientRef = useRef<QrWorkerClient | null>(null);
  const taskRef = useRef<QrWorkerTask | null>(null);
  const decodeAbortRef = useRef<AbortController | null>(null);
  const previewUrlRef = useRef<string | null>(null);
  const mountedRef = useRef(false);
  const executionTokenRef = useRef(0);
  const selectionTokenRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  if (clientRef.current === null) clientRef.current = new QrWorkerClient();

  const textCharacterOver = text.length > QR_CODE_LIMITS.maxTextBytes;
  const textBytes = textCharacterOver
    ? QR_CODE_LIMITS.maxTextBytes + 1
    : getQrTextByteLength(text);
  const eccCapacity = QR_ECC_BYTE_CAPACITY[ecc];
  const textOver = textCharacterOver || textBytes > eccCapacity;

  function revokePreview(): void {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    previewUrlRef.current = null;
    setPreviewUrl(null);
    setGenerateResult(null);
  }

  function clearSelectedImage(): void {
    selectionTokenRef.current += 1;
    setValidatingFile(false);
    setSelectedImage(null);
    setScanResult(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function cancelActive(announce = true): void {
    const wasRunning =
      running || Boolean(taskRef.current || decodeAbortRef.current);
    executionTokenRef.current += 1;
    decodeAbortRef.current?.abort();
    decodeAbortRef.current = null;
    taskRef.current?.cancel();
    taskRef.current = null;
    setRunning(false);
    if (wasRunning && announce) {
      setFeedback({
        kind: "warning",
        message: "二维码任务已取消，Worker、画布和临时像素已释放。",
      });
      window.setTimeout(() => {
        document
          .querySelector<HTMLButtonElement>(
            '[data-tool-workspace="qr-code"] [data-tool-action="execute"]',
          )
          ?.focus();
      }, 0);
    }
  }

  useEffect(() => {
    mountedRef.current = true;
    const client = clientRef.current;
    client?.bindPageHide(window);
    const handlePageHide = () => {
      executionTokenRef.current += 1;
      selectionTokenRef.current += 1;
      decodeAbortRef.current?.abort();
      decodeAbortRef.current = null;
      taskRef.current?.cancel();
      taskRef.current = null;
      if (previewUrlRef.current) {
        URL.revokeObjectURL(previewUrlRef.current);
        previewUrlRef.current = null;
      }
      if (fileInputRef.current) fileInputRef.current.value = "";
      setPreviewUrl(null);
      setGenerateResult(null);
      setScanResult(null);
      setSelectedImage(null);
      setRunning(false);
      setValidatingFile(false);
      setFeedback({
        kind: "idle",
        message: "页面离开时，Worker、图片引用、像素和 Blob URL 已释放。",
      });
    };
    window.addEventListener("pagehide", handlePageHide);
    return () => {
      window.removeEventListener("pagehide", handlePageHide);
      mountedRef.current = false;
      executionTokenRef.current += 1;
      selectionTokenRef.current += 1;
      decodeAbortRef.current?.abort();
      taskRef.current = null;
      client?.dispose();
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!running) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault();
      cancelActive();
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  });

  function switchMode(nextMode: QrMode): void {
    if (nextMode === mode) return;
    cancelActive(false);
    revokePreview();
    clearSelectedImage();
    setMode(nextMode);
    setFeedback({
      kind: "idle",
      message:
        nextMode === "generate"
          ? "输入文本后主动生成；SVG 不包含原文、元数据或外部资源。"
          : "选择静态 JPEG、PNG 或 WebP 后主动识别；结果不会自动打开。",
    });
  }

  async function selectImage(file: File): Promise<void> {
    if (running || validatingFile) return;
    const token = selectionTokenRef.current + 1;
    selectionTokenRef.current = token;
    setSelectedImage(null);
    setScanResult(null);
    const sizeError = validateQrImageFileSize(file.size);
    if (sizeError) {
      setFeedback({ kind: "error", message: sizeError.message });
      return;
    }

    setValidatingFile(true);
    setFeedback({
      kind: "idle",
      message: "正在本地检查图片文件头、动画标记与尺寸…",
    });
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (!mountedRef.current || selectionTokenRef.current !== token) return;
      const inspection = inspectQrImageBytes(bytes);
      if (!inspection.ok) {
        setFeedback({ kind: "error", message: inspection.error.message });
        return;
      }
      setSelectedImage({ file, metadata: inspection.value });
      setFeedback({
        kind: "idle",
        message: `图片头部已验证：${inspection.value.width} × ${inspection.value.height}，${formatBytes(file.size)}。点击识别后才会读取像素。`,
      });
    } catch {
      if (mountedRef.current && selectionTokenRef.current === token) {
        setFeedback({
          kind: "error",
          message: "无法读取图片文件；本次选择未被保留。",
        });
      }
    } finally {
      if (mountedRef.current && selectionTokenRef.current === token) {
        setValidatingFile(false);
      }
    }
  }

  function handleFileInput(event: ChangeEvent<HTMLInputElement>): void {
    const file = event.currentTarget.files?.item(0);
    event.currentTarget.value = "";
    if (file) void selectImage(file);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault();
    setDragging(false);
    if (running || validatingFile) return;
    const fileItems = Array.from(event.dataTransfer.items).filter(
      (item) => item.kind === "file",
    );
    const files =
      fileItems.length > 0
        ? fileItems
            .map((item) => item.getAsFile())
            .filter((file): file is File => file !== null)
        : Array.from(event.dataTransfer.files);
    if (files.length !== 1) {
      setFeedback({
        kind: "error",
        message: "一次只能选择一个本地图片文件；网址拖放不会被处理。",
      });
      return;
    }
    const file = files[0];
    if (file) void selectImage(file);
  }

  function handleDropzoneKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    if (!running && !validatingFile) fileInputRef.current?.click();
  }

  async function runGenerate(): Promise<void> {
    if (running || validatingFile) return;
    if (textBytes === 0 || textOver) {
      setFeedback({
        kind: "error",
        message:
          textBytes === 0
            ? "请输入需要写入二维码的文本。"
            : `${ecc} 级纠错最多接受 ${eccCapacity.toLocaleString("zh-CN")} 字节。`,
      });
      return;
    }
    const client = clientRef.current;
    if (!client) return;
    const token = executionTokenRef.current + 1;
    executionTokenRef.current = token;
    revokePreview();
    setScanResult(null);
    setRunning(true);
    setFeedback({
      kind: "idle",
      message: "正在独立 Worker 中生成固定几何 SVG…",
    });

    let task: QrWorkerTask | null = null;
    try {
      task = client.execute({ mode: "generate", text, ecc, displaySize });
      taskRef.current = task;
      const result = await task.result;
      if (!mountedRef.current || executionTokenRef.current !== token) return;
      if (!result.ok) {
        setFeedback({ kind: "error", message: result.error.message });
        return;
      }
      if (result.mode !== "generate") {
        throw new Error("Unexpected QR result mode");
      }
      const url = URL.createObjectURL(
        new Blob([result.svg], { type: "image/svg+xml" }),
      );
      previewUrlRef.current = url;
      setPreviewUrl(url);
      setGenerateResult(result);
      setFeedback({
        kind: "success",
        message: `二维码已生成：Version ${result.version}，${result.modules} × ${result.modules} 模块。`,
      });
    } catch (error) {
      if (mountedRef.current && executionTokenRef.current === token) {
        setFeedback(failureFeedback(error));
      }
    } finally {
      if (mountedRef.current && executionTokenRef.current === token) {
        if (task && taskRef.current?.taskId === task.taskId)
          taskRef.current = null;
        setRunning(false);
      }
    }
  }

  async function runScan(): Promise<void> {
    if (running || validatingFile) return;
    if (!selectedImage) {
      setFeedback({ kind: "error", message: "请先选择一张静态图片。" });
      return;
    }
    const client = clientRef.current;
    if (!client) return;
    const token = executionTokenRef.current + 1;
    executionTokenRef.current = token;
    setScanResult(null);
    revokePreview();
    setRunning(true);
    setFeedback({ kind: "idle", message: "正在本地解码并按 4 MP 上限缩放…" });
    const abortController = new AbortController();
    decodeAbortRef.current = abortController;
    let task: QrWorkerTask | null = null;

    try {
      const pixels = await decodeQrImageFile(
        selectedImage.file,
        abortController.signal,
      );
      if (!mountedRef.current || executionTokenRef.current !== token) return;
      decodeAbortRef.current = null;
      setFeedback({
        kind: "idle",
        message: pixels.resized
          ? `已缩至 ${pixels.width} × ${pixels.height}，正在独立 Worker 中识别…`
          : `已读取 ${pixels.width} × ${pixels.height} 像素，正在独立 Worker 中识别…`,
      });
      task = client.execute({
        mode: "scan",
        rgba: pixels.rgba,
        width: pixels.width,
        height: pixels.height,
        inversionAttempts: attemptInversion ? "attemptBoth" : "dontInvert",
      });
      taskRef.current = task;
      const result = await task.result;
      if (!mountedRef.current || executionTokenRef.current !== token) return;
      if (!result.ok) {
        setFeedback({
          kind: result.error.code === "not-found" ? "warning" : "error",
          message: result.error.message,
        });
        return;
      }
      if (result.mode !== "scan") throw new Error("Unexpected QR result mode");
      setScanResult(result);
      setFeedback({
        kind: "success",
        message: `识别完成：Version ${result.version}，结果 ${formatBytes(result.textBytes)}。`,
      });
    } catch (error) {
      if (mountedRef.current && executionTokenRef.current === token) {
        setFeedback(failureFeedback(error));
      }
    } finally {
      if (mountedRef.current && executionTokenRef.current === token) {
        decodeAbortRef.current = null;
        if (task && taskRef.current?.taskId === task.taskId)
          taskRef.current = null;
        setRunning(false);
      }
    }
  }

  function runCurrentMode(): void {
    if (mode === "generate") void runGenerate();
    else void runScan();
  }

  function handleTextShortcut(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (
      (event.ctrlKey || event.metaKey) &&
      event.key === "Enter" &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      void runGenerate();
    }
  }

  async function copyScanResult(): Promise<void> {
    if (!scanResult) return;
    try {
      await copyText(scanResult.text);
      setFeedback({ kind: "success", message: "识别结果已复制为纯文本。" });
    } catch {
      setFeedback({
        kind: "error",
        message: "复制失败；页面不会自动改用网址、存储或其他传输方式。",
      });
    }
  }

  function loadExample(): void {
    cancelActive(false);
    revokePreview();
    clearSelectedImage();
    setMode("generate");
    setText(SAMPLE_TEXT);
    setEcc("M");
    setDisplaySize(512);
    setFeedback({
      kind: "idle",
      message: "Unicode 安全示例已载入；点击生成。",
    });
  }

  function clearWorkspace(): void {
    cancelActive(false);
    revokePreview();
    clearSelectedImage();
    setText("");
    setFeedback({
      kind: "idle",
      message: "文本、文件引用、结果与临时 Blob URL 已清空。",
    });
  }

  return (
    <ToolWorkspace
      toolId="qr-code"
      titleId={titleId}
      className="qr-tool"
      aria-busy={running || validatingFile}
    >
      <ToolWorkspaceHeader className="qr-tool__heading">
        <div>
          <p className="eyebrow">Dedicated Worker · 8 秒硬超时</p>
          <h2 id={titleId}>本地生成与识别二维码</h2>
        </div>
        <p>二维码内容不等于可信链接；识别结果始终只显示为纯文本。</p>
      </ToolWorkspaceHeader>

      <fieldset className="qr-tool__modes">
        <legend id={modeLegendId}>选择模式</legend>
        <div>
          <label>
            <input
              type="radio"
              name="qr-mode"
              value="generate"
              checked={mode === "generate"}
              onChange={() => switchMode("generate")}
            />
            <span>
              <strong>生成二维码</strong>
              <small>文本 → 固定 SVG</small>
            </span>
          </label>
          <label>
            <input
              type="radio"
              name="qr-mode"
              value="scan"
              checked={mode === "scan"}
              onChange={() => switchMode("scan")}
            />
            <span>
              <strong>识别图片</strong>
              <small>静态图片 → 纯文本</small>
            </span>
          </label>
        </div>
      </fieldset>

      <ToolWorkspaceRegion region="input" className="qr-tool__input">
        {mode === "generate" ? (
          <div className="qr-tool__generate-grid" data-qr-mode="generate">
            <div className="qr-tool__text-field">
              <div className="qr-tool__field-head">
                <label htmlFor={textId}>要编码的文本</label>
                <span
                  id={textCountId}
                  className={textOver ? "is-over" : undefined}
                >
                  {formatBytes(textBytes)} / {formatBytes(eccCapacity)}
                </span>
              </div>
              <textarea
                id={textId}
                value={text}
                rows={9}
                maxLength={QR_CODE_LIMITS.maxTextBytes}
                dir="auto"
                spellCheck={false}
                readOnly={running}
                aria-invalid={textOver}
                aria-describedby={`${textCountId} ${feedbackId}`}
                aria-keyshortcuts="Control+Enter Meta+Enter Escape"
                data-privacy-canary-input
                onKeyDown={handleTextShortcut}
                onChange={(event) => {
                  revokePreview();
                  setText(event.target.value);
                  setFeedback({
                    kind: "idle",
                    message: "文本已更改；只会在点击生成后送入独立 Worker。",
                  });
                }}
              />
            </div>

            <div className="qr-tool__settings">
              <fieldset disabled={running}>
                <legend>纠错级别</legend>
                <div className="qr-tool__ecc-grid">
                  {QR_ERROR_CORRECTION_LEVELS.map((level) => (
                    <label key={level}>
                      <input
                        type="radio"
                        name="qr-ecc"
                        value={level}
                        checked={ecc === level}
                        onChange={() => {
                          revokePreview();
                          setEcc(level);
                          setFeedback({
                            kind: "idle",
                            message: `${level} 级纠错容量为 ${QR_ECC_BYTE_CAPACITY[level].toLocaleString("zh-CN")} 字节。`,
                          });
                        }}
                      />
                      <span>
                        <strong>{ECC_LABELS[level].title}</strong>
                        <small>{ECC_LABELS[level].detail}</small>
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <label className="qr-tool__select-field">
                <span>下载显示尺寸</span>
                <select
                  value={displaySize}
                  disabled={running}
                  onChange={(event) => {
                    const nextDisplaySize = Number(
                      event.target.value,
                    ) as QrDisplaySize;
                    const clearedPreview = Boolean(
                      generateResult || previewUrl,
                    );
                    revokePreview();
                    setDisplaySize(nextDisplaySize);
                    setFeedback({
                      kind: "idle",
                      message: clearedPreview
                        ? `下载尺寸已设为 ${nextDisplaySize} × ${nextDisplaySize} px；旧预览已清除，请重新生成。`
                        : `下载尺寸已设为 ${nextDisplaySize} × ${nextDisplaySize} px；生成时将使用此尺寸。`,
                    });
                  }}
                >
                  {QR_DISPLAY_SIZES.map((size) => (
                    <option key={size} value={size}>
                      {size} × {size} px
                    </option>
                  ))}
                </select>
              </label>
              <p>
                SVG
                只有固定白底与深色路径；不会嵌入输入文本、标题、脚本或外部资源。
              </p>
            </div>
          </div>
        ) : (
          <div className="qr-tool__scan-input" data-qr-mode="scan">
            <input
              ref={fileInputRef}
              id={fileInputId}
              className="qr-tool__file-input"
              type="file"
              aria-label="选择二维码图片文件"
              tabIndex={-1}
              accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
              disabled={running || validatingFile}
              onChange={handleFileInput}
            />
            <div
              className={`qr-tool__dropzone${dragging ? " is-dragging" : ""}`}
              role="button"
              tabIndex={running || validatingFile ? -1 : 0}
              aria-disabled={running || validatingFile}
              aria-describedby={fileHelpId}
              data-qr-dropzone
              onClick={() => {
                if (!running && !validatingFile) fileInputRef.current?.click();
              }}
              onKeyDown={handleDropzoneKeyDown}
              onDragEnter={(event) => {
                event.preventDefault();
                if (!running && !validatingFile) setDragging(true);
              }}
              onDragOver={(event) => event.preventDefault()}
              onDragLeave={() => setDragging(false)}
              onDrop={handleDrop}
            >
              <span aria-hidden="true">▣</span>
              <strong>
                {validatingFile ? "正在验证文件头…" : "选择或拖入一张图片"}
              </strong>
              <small id={fileHelpId}>
                JPEG / PNG / WebP，静态单帧，最大 20 MiB
              </small>
            </div>

            {selectedImage ? (
              <dl className="qr-tool__file-summary">
                <div>
                  <dt>文件</dt>
                  <dd>{selectedImage.file.name}</dd>
                </div>
                <div>
                  <dt>容器</dt>
                  <dd>{selectedImage.metadata.format.toUpperCase()}</dd>
                </div>
                <div>
                  <dt>尺寸</dt>
                  <dd>
                    {selectedImage.metadata.width} ×{" "}
                    {selectedImage.metadata.height}
                  </dd>
                </div>
                <div>
                  <dt>大小</dt>
                  <dd>{formatBytes(selectedImage.file.size)}</dd>
                </div>
              </dl>
            ) : (
              <p className="qr-tool__file-empty">
                文件头会在像素解码前验证；SVG、动画、损坏文件和像素炸弹会被拒绝。
              </p>
            )}

            <label className="qr-tool__inversion">
              <input
                type="checkbox"
                checked={attemptInversion}
                disabled={running || validatingFile}
                onChange={(event) => {
                  const nextAttemptInversion = event.target.checked;
                  const clearedResult = scanResult !== null;
                  setAttemptInversion(nextAttemptInversion);
                  setScanResult(null);
                  setFeedback({
                    kind: "idle",
                    message: clearedResult
                      ? `反色识别已${nextAttemptInversion ? "开启" : "关闭"}；旧结果已清除，请重新识别。`
                      : `反色识别已${nextAttemptInversion ? "开启" : "关闭"}；下次识别将使用此设置。`,
                  });
                }}
              />
              <span>
                <strong>同时尝试反色二维码</strong>
                <small>覆盖深底浅码；会增加本地计算时间。</small>
              </span>
            </label>
          </div>
        )}
      </ToolWorkspaceRegion>

      <div
        id={feedbackId}
        className={`qr-tool__feedback qr-tool__feedback--${feedback.kind}`}
        role={feedback.kind === "error" ? "alert" : "status"}
        aria-live={feedback.kind === "error" ? "assertive" : "polite"}
        data-qr-status={
          running ? "running" : validatingFile ? "validating" : feedback.kind
        }
      >
        <span aria-hidden="true">
          {feedback.kind === "success"
            ? "✓"
            : feedback.kind === "error"
              ? "!"
              : "i"}
        </span>
        <p>{feedback.message}</p>
      </div>

      <ToolWorkspaceRegion region="output" className="qr-tool__output">
        {generateResult && previewUrl ? (
          <div className="qr-tool__generated" data-qr-preview>
            <div className="qr-tool__preview-frame">
              <img src={previewUrl} alt="已生成的二维码预览" />
            </div>
            <div>
              <p className="eyebrow">固定 SVG 已就绪</p>
              <h3>Version {generateResult.version}</h3>
              <ul>
                <li>{generateResult.ecc} 级纠错</li>
                <li>
                  {generateResult.modules} × {generateResult.modules} 模块
                </li>
                <li>{formatBytes(generateResult.outputBytes)}</li>
              </ul>
              <p>预览替换、清空或离开页面时，临时 Blob URL 会立即撤销。</p>
            </div>
          </div>
        ) : scanResult ? (
          <div className="qr-tool__recognized">
            <div className="qr-tool__result-head">
              <div>
                <p className="eyebrow">识别结果 · 纯文本</p>
                <h3>内容未验证，也不会自动打开</h3>
              </div>
              <span>
                Version {scanResult.version} ·{" "}
                {formatBytes(scanResult.textBytes)}
              </span>
            </div>
            <label htmlFor={resultId}>二维码文本</label>
            <textarea
              id={resultId}
              value={scanResult.text}
              rows={8}
              dir="auto"
              readOnly
              spellCheck={false}
              data-qr-scan-result
            />
            <p className="qr-tool__trust-warning">
              即使内容看起来像 https:、javascript:
              或其他网址，本工具也只显示和复制文字。
            </p>
          </div>
        ) : (
          <div className="qr-tool__empty">
            <h3>{running ? "本地任务进行中" : "等待主动执行"}</h3>
            <p>
              {running
                ? "可按 Escape 或点击取消；当前阶段完成前不会保留中间像素。"
                : mode === "generate"
                  ? "设置文本与纠错级别后生成二维码。"
                  : "选择通过头部验证的静态图片后开始识别。"}
            </p>
          </div>
        )}
      </ToolWorkspaceRegion>

      <ToolWorkspaceActions className="qr-tool__actions">
        {running ? (
          <ToolWorkspaceAction
            action="cancel"
            className="button button--primary"
            type="button"
            aria-keyshortcuts="Escape"
            onClick={() => cancelActive()}
          >
            取消并释放
          </ToolWorkspaceAction>
        ) : (
          <ToolWorkspaceAction
            action="execute"
            className="button button--primary"
            type="button"
            disabled={
              validatingFile ||
              (mode === "generate"
                ? textBytes === 0 || textOver
                : !selectedImage)
            }
            data-privacy-canary-action
            onClick={runCurrentMode}
          >
            {mode === "generate" ? "生成二维码" : "识别二维码"}
          </ToolWorkspaceAction>
        )}
        <ToolWorkspaceAction
          action="download"
          className="button button--secondary"
          type="button"
          disabled={running || !previewUrl}
          onClick={() => previewUrl && triggerDownload(previewUrl)}
        >
          下载 SVG
        </ToolWorkspaceAction>
        <ToolWorkspaceAction
          action="copy"
          className="button button--secondary"
          type="button"
          disabled={running || !scanResult}
          onClick={() => void copyScanResult()}
        >
          复制识别文本
        </ToolWorkspaceAction>
        <ToolWorkspaceAction
          action="example"
          className="button button--quiet"
          type="button"
          disabled={running || validatingFile}
          onClick={loadExample}
        >
          载入 Unicode 示例
        </ToolWorkspaceAction>
        <ToolWorkspaceAction
          action="clear"
          className="button button--quiet"
          type="button"
          disabled={running || validatingFile}
          onClick={clearWorkspace}
        >
          清空
        </ToolWorkspaceAction>
        <span className="qr-tool__shortcut">
          生成可用 <kbd>Ctrl</kbd>/<kbd>⌘</kbd> + <kbd>Enter</kbd>
          <span aria-hidden="true"> · </span>
          <kbd>Esc</kbd> 取消
        </span>
      </ToolWorkspaceActions>
    </ToolWorkspace>
  );
}

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type DragEvent,
} from "react";

import {
  WorkflowBatchError,
  WorkflowBatchQueue,
  type WorkflowBatchItemSnapshot,
  type WorkflowBatchSnapshot,
} from "../../workflows/batch";
import {
  MAX_WORKFLOW_BATCH_FILES,
  MAX_WORKFLOW_BATCH_SOURCE_BYTES,
  WorkflowFileInputError,
  getWorkflowFilePolicy,
  getWorkflowPlanFilePolicy,
  readWorkflowSourceFile,
  validateWorkflowFileQueue,
  type WorkflowFilePolicy,
  type WorkflowFilePolicySource,
} from "../../workflows/file-input";
import type { WorkflowPlan } from "../../workflows/planner";
import { exportWorkflowPrivacyReceiptCanonical } from "../../workflows/receipt";
import type { WorkflowTemplateId } from "../../workflows/templates";
import { WorkflowZipError, createWorkflowStoreZip } from "../../workflows/zip";
import { decodeWorkflowImageInBrowser } from "./browser-image-decoder";
import "./WorkflowBatchPanel.css";

interface WorkflowBatchPanelProps {
  readonly plan?: WorkflowPlan;
  readonly templateId?: WorkflowTemplateId;
  readonly disabled?: boolean;
  readonly onBusyChange?: (busy: boolean) => void;
}

interface BatchUiItem {
  readonly itemId: string;
  readonly displayName: string;
  readonly sourceBytes: number;
  readonly file?: File;
}

type BatchFeedback = Readonly<{
  kind: "idle" | "success" | "warning" | "error";
  message: string;
}>;

const EMPTY_SNAPSHOT: WorkflowBatchSnapshot = Object.freeze({
  status: "idle",
  disposed: false,
  items: Object.freeze([]),
});

const MAX_DISPLAY_NAME_CODE_POINTS = 120;
const MAX_BATCH_ZIP_BYTES = 48 * 1024 * 1024;

const statusLabels: Readonly<
  Record<WorkflowBatchItemSnapshot["status"], string>
> = Object.freeze({
  pending: "等待处理",
  running: "处理中",
  succeeded: "已完成",
  failed: "处理失败",
  cancelled: "已取消",
});

const batchErrorMessages: Readonly<Record<string, string>> = Object.freeze({
  "input-failed": "文件读取或格式检查失败，可以修正后重试。",
  "item-size-limit": "该项超过单项内存安全限制。",
  "total-size-limit": "批处理结果超过总内存安全限制。",
  "execution-failed": "本地执行失败，可以单独重试这一项。",
  "operation-failed": "某个工作流步骤无法处理该文件。",
  "incompatible-step": "文件输入与当前第一步的数据类型不兼容。",
  "invalid-options": "当前配方选项无效。",
  "vault-limit": "当前设备无法安全保留这一项的结果。",
  cancelled: "该项已取消，临时数据已经释放。",
});

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

function readableName(value: string): string {
  const normalized = [...value.normalize("NFC")]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f ? "�" : character;
    })
    .join("")
    .trim();
  const codePoints = [...(normalized || "未命名文件")];
  return codePoints.length <= MAX_DISPLAY_NAME_CODE_POINTS
    ? codePoints.join("")
    : `${codePoints.slice(0, MAX_DISPLAY_NAME_CODE_POINTS - 1).join("")}…`;
}

function contentTypeExtension(contentType: string): "json" | "txt" | "bin" {
  if (contentType === "application/json") return "json";
  if (
    contentType.startsWith("text/") ||
    contentType === "application/base64" ||
    contentType === "application/base64url"
  ) {
    return "txt";
  }
  return "bin";
}

function generatedResultName(index: number, contentType: string): string {
  return `workflow-result-${String(index + 1).padStart(3, "0")}.${contentTypeExtension(contentType)}`;
}

function compatibleContentType(actual: string, accepted: string): boolean {
  const [actualType, actualSubtype] = actual.split("/", 2);
  const [acceptedType, acceptedSubtype] = accepted.split("/", 2);
  return (
    (acceptedType === "*" || acceptedType === actualType) &&
    (acceptedSubtype === "*" || acceptedSubtype === actualSubtype)
  );
}

function planAcceptsTemplateInput(
  plan: WorkflowPlan | undefined,
  policy: WorkflowFilePolicy | undefined,
): boolean {
  const first = plan?.steps[0];
  if (policy === undefined || first === undefined) return false;
  return first.input.some(
    (candidate) =>
      candidate.kind === policy.inputKind &&
      compatibleContentType(policy.semanticType, candidate.contentType),
  );
}

function customPolicyGuidance(plan: WorkflowPlan | undefined): string {
  const first = plan?.steps[0];
  if (first === undefined) {
    return "先添加并配置一个有效步骤，工作台才会建立文件输入策略。";
  }
  const kinds = new Set(first.input.map((candidate) => candidate.kind));
  if (kinds.has("empty")) {
    return "当前首步无需正文或文件，请在上方输入区直接运行工作流。";
  }
  if (kinds.has("text-pair")) {
    return "双文本输入不能从单个文件安全推断，请从文本差异工具进入并分别提供两段正文。";
  }
  if (kinds.has("rgba-image")) {
    return "自定义流程不会把普通文件隐式解码为 RGBA 像素；请载入内置图片工作流完成受限解码。";
  }
  if (kinds.has("binary")) {
    return "自定义流程不会把文件隐式标记为任意二进制类型；请先使用能产生兼容二进制结果的受控步骤。";
  }
  return "当前首步没有可安全读取的 UTF-8 文本文件输入，请更换第一步。";
}

function friendlyFailure(error: unknown): string {
  if (error instanceof WorkflowFileInputError) return error.message;
  if (error instanceof WorkflowBatchError) {
    switch (error.code) {
      case "item-limit":
        return `一次最多保留 ${MAX_WORKFLOW_BATCH_FILES} 个队列项。`;
      case "item-size-limit":
        return "文件或结果超过单项内存安全限制。";
      case "total-size-limit":
        return "当前队列超过批处理总内存安全限制。";
      case "run-conflict":
        return "批处理正在运行，请先取消或等待完成。";
      default:
        return "无法更新批处理队列，请清空后重试。";
    }
  }
  if (error instanceof WorkflowZipError) {
    return error.code === "cancelled"
      ? "ZIP 生成已取消。"
      : "结果数量或大小超过 ZIP 安全限制。";
  }
  return "本地批处理未能完成，请检查文件后重试。";
}

function itemFailureLabel(item: WorkflowBatchItemSnapshot): string {
  return item.errorCode === undefined
    ? ""
    : (batchErrorMessages[item.errorCode] ?? "本地处理失败，可以单独重试。");
}

function triggerDownload(url: string, name: string): void {
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
}

export default function WorkflowBatchPanel({
  plan,
  templateId,
  disabled = false,
  onBusyChange,
}: WorkflowBatchPanelProps) {
  const panelId = useId();
  const inputId = useId();
  const feedbackId = useId();
  const [items, setItems] = useState<BatchUiItem[]>([]);
  const [snapshot, setSnapshot] =
    useState<WorkflowBatchSnapshot>(EMPTY_SNAPSHOT);
  const [feedback, setFeedback] = useState<BatchFeedback>({
    kind: "idle",
    message: "文件会逐个读取和处理，不会一次解码整批内容。",
  });
  const [busy, setBusy] = useState(false);
  const [buildingZip, setBuildingZip] = useState(false);
  const [dragging, setDragging] = useState(false);

  const queueRef = useRef<WorkflowBatchQueue | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pollTimerRef = useRef<number | null>(null);
  const resultUrlsRef = useRef(new Map<string, string>());
  const ephemeralUrlsRef = useRef(new Set<string>());
  const zipAbortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(false);

  const policy = useMemo(
    () =>
      templateId === undefined
        ? getWorkflowPlanFilePolicy(plan)
        : getWorkflowFilePolicy(templateId),
    [plan, templateId],
  );
  const planCompatible = useMemo(
    () => planAcceptsTemplateInput(plan, policy),
    [plan, policy],
  );
  const policySource: WorkflowFilePolicySource | undefined = templateId ?? plan;
  const itemById = useMemo(
    () => new Map(snapshot.items.map((item) => [item.itemId, item])),
    [snapshot.items],
  );
  const succeeded = snapshot.items.filter(
    (item) => item.status === "succeeded",
  ).length;
  const failed = snapshot.items.filter(
    (item) => item.status === "failed",
  ).length;
  const pending = snapshot.items.filter(
    (item) => item.status === "pending" || item.status === "running",
  ).length;
  const controlsDisabled = disabled || busy || buildingZip || !planCompatible;

  const releaseEphemeralUrls = useCallback(() => {
    for (const url of ephemeralUrlsRef.current) URL.revokeObjectURL(url);
    ephemeralUrlsRef.current.clear();
  }, []);

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current !== null) {
      window.clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const syncQueue = useCallback((queue: WorkflowBatchQueue) => {
    if (queueRef.current !== queue || !mountedRef.current) return;
    const next = queue.snapshot();
    setSnapshot(next);
    const terminalIds = new Set(
      next.items
        .filter(
          (item) => item.status === "succeeded" || item.status === "cancelled",
        )
        .map((item) => item.itemId),
    );
    if (terminalIds.size > 0) {
      setItems((current) =>
        current.map((item) =>
          terminalIds.has(item.itemId) && item.file !== undefined
            ? {
                itemId: item.itemId,
                displayName: item.displayName,
                sourceBytes: item.sourceBytes,
              }
            : item,
        ),
      );
    }
  }, []);

  const setBatchBusy = useCallback(
    (next: boolean) => {
      if (mountedRef.current) setBusy(next);
      onBusyChange?.(next);
    },
    [onBusyChange],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    stopPolling();
    zipAbortRef.current?.abort();
    zipAbortRef.current = null;
    queueRef.current?.dispose();
    queueRef.current = null;
    const resultUrls = resultUrlsRef.current;
    resultUrls.clear();
    releaseEphemeralUrls();

    if (plan === undefined) return;
    const queue = new WorkflowBatchQueue(plan, {
      maxItems: MAX_WORKFLOW_BATCH_FILES,
      maxTotalBytes: MAX_WORKFLOW_BATCH_SOURCE_BYTES,
    });
    queueRef.current = queue;
    const onPageHide = () => {
      stopPolling();
      zipAbortRef.current?.abort();
      zipAbortRef.current = null;
      queue.clear();
      releaseEphemeralUrls();
      resultUrls.clear();
      setItems([]);
      setSnapshot(queue.snapshot());
      setBatchBusy(false);
      setBuildingZip(false);
      setFeedback({
        kind: "idle",
        message: "页面已隐藏，文件引用、结果和下载资源均已释放。",
      });
      if (fileInputRef.current !== null) fileInputRef.current.value = "";
    };
    window.addEventListener("pagehide", onPageHide);

    return () => {
      window.removeEventListener("pagehide", onPageHide);
      stopPolling();
      zipAbortRef.current?.abort();
      zipAbortRef.current = null;
      queue.dispose();
      if (queueRef.current === queue) queueRef.current = null;
      resultUrls.clear();
      releaseEphemeralUrls();
      onBusyChange?.(false);
    };
  }, [onBusyChange, plan, releaseEphemeralUrls, setBatchBusy, stopPolling]);

  function downloadTemporary(blob: Blob, name: string): void {
    const url = URL.createObjectURL(blob);
    ephemeralUrlsRef.current.add(url);
    triggerDownload(url, name);
    window.setTimeout(() => {
      if (ephemeralUrlsRef.current.delete(url)) URL.revokeObjectURL(url);
    }, 1_500);
  }

  function addFiles(list: FileList | readonly File[]): void {
    const queue = queueRef.current;
    const source = policySource;
    if (queue === null || controlsDisabled || source === undefined) return;
    const selected = Array.from(list);
    if (selected.length === 0) return;

    const validation = validateWorkflowFileQueue(
      [
        ...items.map((item) => ({ size: item.sourceBytes })),
        ...selected.map((file) => ({ size: file.size })),
      ],
      source,
    );
    if (!validation.ok) {
      setFeedback({ kind: "error", message: validation.error.message });
      return;
    }

    const additions: BatchUiItem[] = [];
    try {
      for (const file of selected) {
        const admitted = queue.enqueue({
          bytes: file.size,
          async inputFactory(signal) {
            const decoded = await readWorkflowSourceFile(file, source, {
              signal,
              imageDecoder: decodeWorkflowImageInBrowser,
            });
            return {
              payload: decoded.input,
              semanticType: decoded.semanticType,
            };
          },
        });
        additions.push({
          itemId: admitted.itemId,
          displayName: readableName(file.name),
          sourceBytes: file.size,
          file,
        });
      }
      setItems((current) => [...current, ...additions]);
      syncQueue(queue);
      setFeedback({
        kind: "success",
        message: `已加入 ${additions.length} 个文件；点击开始后会严格串行处理。`,
      });
    } catch (error) {
      if (additions.length > 0) {
        setItems((current) => [...current, ...additions]);
        syncQueue(queue);
      }
      setFeedback({ kind: "error", message: friendlyFailure(error) });
    } finally {
      if (fileInputRef.current !== null) fileInputRef.current.value = "";
    }
  }

  async function runBatch(): Promise<void> {
    const queue = queueRef.current;
    if (queue === null || controlsDisabled || pending === 0) return;
    setBatchBusy(true);
    setFeedback({ kind: "idle", message: "正在本地逐项处理…" });
    stopPolling();
    pollTimerRef.current = window.setInterval(() => syncQueue(queue), 100);
    try {
      const completed = await queue.start();
      if (queueRef.current !== queue) return;
      setSnapshot(completed);
      syncQueue(queue);
      const completedSuccess = completed.items.filter(
        (item) => item.status === "succeeded",
      ).length;
      const completedFailure = completed.items.filter(
        (item) => item.status === "failed",
      ).length;
      setFeedback({
        kind: completedFailure > 0 ? "warning" : "success",
        message:
          completedFailure > 0
            ? `已完成 ${completedSuccess} 项，${completedFailure} 项失败；失败项可以单独重试。`
            : `已在本地完成 ${completedSuccess} 项。`,
      });
    } catch (error) {
      if (queueRef.current === queue) {
        syncQueue(queue);
        setFeedback({ kind: "error", message: friendlyFailure(error) });
      }
    } finally {
      stopPolling();
      if (queueRef.current === queue) setBatchBusy(false);
    }
  }

  async function retryItem(itemId: string): Promise<void> {
    const queue = queueRef.current;
    if (queue === null || controlsDisabled) return;
    setBatchBusy(true);
    setFeedback({ kind: "idle", message: "正在单独重试失败项…" });
    pollTimerRef.current = window.setInterval(() => syncQueue(queue), 100);
    try {
      await queue.retry(itemId);
      if (queueRef.current !== queue) return;
      syncQueue(queue);
      const item = queue
        .snapshot()
        .items.find((candidate) => candidate.itemId === itemId);
      setFeedback({
        kind: item?.status === "succeeded" ? "success" : "warning",
        message:
          item?.status === "succeeded"
            ? "该项已在本地重试成功。"
            : "该项仍未通过，请检查文件格式或当前配方。",
      });
    } catch (error) {
      if (queueRef.current === queue) {
        syncQueue(queue);
        setFeedback({ kind: "error", message: friendlyFailure(error) });
      }
    } finally {
      stopPolling();
      if (queueRef.current === queue) setBatchBusy(false);
    }
  }

  function cancelBatch(): void {
    const queue = queueRef.current;
    zipAbortRef.current?.abort();
    zipAbortRef.current = null;
    releaseEphemeralUrls();
    if (queue === null) return;
    const cancelled = queue.cancel();
    resultUrlsRef.current.clear();
    syncQueue(queue);
    setBatchBusy(false);
    setBuildingZip(false);
    setFeedback({
      kind: cancelled ? "warning" : "idle",
      message: cancelled
        ? "批处理已取消，排队输入、中间结果和对象 URL 已释放。"
        : "当前没有可取消的队列项。",
    });
  }

  function cancelItem(itemId: string): void {
    const queue = queueRef.current;
    if (queue === null) return;
    try {
      if (queue.cancel(itemId)) {
        resultUrlsRef.current.delete(itemId);
        syncQueue(queue);
        setFeedback({
          kind: "warning",
          message: "该项已取消，对应临时数据已经释放。",
        });
      }
    } catch (error) {
      setFeedback({ kind: "error", message: friendlyFailure(error) });
    }
  }

  function clearBatch(): void {
    const queue = queueRef.current;
    stopPolling();
    zipAbortRef.current?.abort();
    zipAbortRef.current = null;
    queue?.clear();
    resultUrlsRef.current.clear();
    releaseEphemeralUrls();
    setItems([]);
    setSnapshot(queue?.snapshot() ?? EMPTY_SNAPSHOT);
    setBatchBusy(false);
    setBuildingZip(false);
    setFeedback({
      kind: "idle",
      message: "文件名、文件引用、结果和回执状态已从当前标签页清空。",
    });
    if (fileInputRef.current !== null) fileInputRef.current.value = "";
  }

  function downloadResult(itemId: string, index: number): void {
    const queue = queueRef.current;
    if (queue === null) return;
    try {
      const result = queue.resultBytes(itemId);
      let url = resultUrlsRef.current.get(itemId);
      if (url === undefined) {
        url = queue.createResultObjectUrl(itemId);
        resultUrlsRef.current.set(itemId, url);
      }
      triggerDownload(url, generatedResultName(index, result.contentType));
      setFeedback({ kind: "success", message: "已生成本地结果下载。" });
    } catch (error) {
      setFeedback({ kind: "error", message: friendlyFailure(error) });
    }
  }

  async function downloadZip(): Promise<void> {
    const queue = queueRef.current;
    if (queue === null || succeeded === 0 || controlsDisabled) return;
    const controller = new AbortController();
    zipAbortRef.current = controller;
    setBuildingZip(true);
    setFeedback({ kind: "idle", message: "正在本地打包有限大小的 ZIP…" });
    try {
      const successfulItems = queue
        .snapshot()
        .items.filter((item) => item.status === "succeeded");
      const entries = successfulItems.map((item, index) => {
        const result = queue.resultBytes(item.itemId);
        return {
          data: result.data,
          downloadName: generatedResultName(index, result.contentType),
        };
      });
      const archive = await createWorkflowStoreZip(entries, {
        signal: controller.signal,
        maxEntries: MAX_WORKFLOW_BATCH_FILES,
        maxArchiveBytes: MAX_BATCH_ZIP_BYTES,
      });
      if (queueRef.current !== queue || controller.signal.aborted) return;
      downloadTemporary(
        new Blob([archive], { type: "application/zip" }),
        "workflow-results.zip",
      );
      setFeedback({
        kind: "success",
        message: `已在本地打包 ${entries.length} 个结果；ZIP 使用通用结果名。`,
      });
    } catch (error) {
      if (queueRef.current === queue) {
        setFeedback({ kind: "error", message: friendlyFailure(error) });
      }
    } finally {
      if (zipAbortRef.current === controller) zipAbortRef.current = null;
      if (queueRef.current === queue) setBuildingZip(false);
    }
  }

  function downloadReceipt(): void {
    const queue = queueRef.current;
    if (queue === null || snapshot.items.length === 0) return;
    try {
      const canonical = exportWorkflowPrivacyReceiptCanonical(
        queue.receiptSource(),
      );
      downloadTemporary(
        new Blob([canonical], { type: "application/json" }),
        "workflow-privacy-receipt.json",
      );
      setFeedback({
        kind: "success",
        message:
          "隐私回执已生成：只含配方、状态与计数，不含文件名、正文或哈希。",
      });
    } catch (error) {
      setFeedback({ kind: "error", message: friendlyFailure(error) });
    }
  }

  return (
    <section
      className="workflow-studio__batch-panel"
      aria-labelledby={`${panelId}-title`}
      aria-describedby={feedbackId}
      aria-busy={busy || buildingZip}
      data-workflow-batch
      data-batch-status={snapshot.status}
      data-batch-busy={busy || buildingZip}
      data-policy-source={templateId === undefined ? "plan" : "template"}
      data-input-kind={policy?.inputKind ?? "unsupported"}
      data-semantic-type={policy?.semanticType}
    >
      <div className="workflow-studio__batch-heading">
        <div>
          <p className="workflow-studio__batch-eyebrow">
            <span>03</span> 文件批处理
          </p>
          <h3 id={`${panelId}-title`}>一批文件，一条本地流水线</h3>
          <p>
            逐项读取、失败隔离、单项重试；低内存设备始终串行，不会同时解码整批文件。
          </p>
        </div>
        <div className="workflow-studio__batch-metrics" aria-label="队列摘要">
          <span>
            <strong>{snapshot.items.length}</strong> 总计
          </span>
          <span>
            <strong>{succeeded}</strong> 完成
          </span>
          <span>
            <strong>{failed}</strong> 失败
          </span>
        </div>
      </div>

      {!planCompatible ? (
        <div className="workflow-studio__batch-compatibility" role="status">
          {templateId === undefined
            ? customPolicyGuidance(plan)
            : "当前第一步与此模板的文件输入不兼容。恢复内置模板或调整第一步后即可批处理。"}
        </div>
      ) : (
        <label
          className={`workflow-studio__batch-dropzone ${dragging ? "is-dragging" : ""} ${controlsDisabled ? "is-disabled" : ""}`}
          htmlFor={inputId}
          onDragEnter={(event) => {
            event.preventDefault();
            if (!controlsDisabled) setDragging(true);
          }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={(event) => {
            event.preventDefault();
            if (
              !event.currentTarget.contains(event.relatedTarget as Node | null)
            ) {
              setDragging(false);
            }
          }}
          onDrop={(event: DragEvent<HTMLLabelElement>) => {
            event.preventDefault();
            setDragging(false);
            addFiles(event.dataTransfer.files);
          }}
        >
          <input
            ref={fileInputRef}
            id={inputId}
            type="file"
            multiple
            disabled={controlsDisabled}
            accept={policy?.accept}
            aria-describedby={feedbackId}
            data-batch-file-input
            onChange={(event) => addFiles(event.currentTarget.files ?? [])}
          />
          <span className="workflow-studio__batch-drop-icon" aria-hidden="true">
            ＋
          </span>
          <span>
            <strong>选择文件或拖到这里</strong>
            <small>
              最多 {MAX_WORKFLOW_BATCH_FILES} 项 · 总源文件不超过{" "}
              {formatBytes(MAX_WORKFLOW_BATCH_SOURCE_BYTES)}
            </small>
          </span>
          <span className="workflow-studio__batch-local">仅本地</span>
        </label>
      )}

      {items.length > 0 ? (
        <ol className="workflow-studio__batch-list" aria-label="批处理文件队列">
          {items.map((item, index) => {
            const state = itemById.get(item.itemId);
            const status = state?.status ?? "pending";
            return (
              <li
                key={item.itemId}
                className={`is-${status}`}
                data-batch-item
                data-item-id={item.itemId}
                data-item-status={status}
              >
                <span
                  className="workflow-studio__batch-index"
                  aria-hidden="true"
                >
                  {String(index + 1).padStart(2, "0")}
                </span>
                <span className="workflow-studio__batch-file">
                  <strong>{item.displayName}</strong>
                  <small>{formatBytes(state?.bytes ?? item.sourceBytes)}</small>
                </span>
                <span className={`workflow-studio__batch-status is-${status}`}>
                  <i aria-hidden="true" /> {statusLabels[status]}
                </span>
                <span className="workflow-studio__batch-item-actions">
                  {status === "succeeded" ? (
                    <button
                      type="button"
                      disabled={disabled || busy || buildingZip}
                      data-action="download-result"
                      onClick={() => downloadResult(item.itemId, index)}
                    >
                      下载
                    </button>
                  ) : null}
                  {status === "failed" ? (
                    <button
                      type="button"
                      disabled={controlsDisabled}
                      data-action="retry-item"
                      onClick={() => void retryItem(item.itemId)}
                    >
                      重试
                    </button>
                  ) : null}
                  {status === "pending" || status === "running" ? (
                    <button
                      type="button"
                      className="is-quiet"
                      disabled={disabled || buildingZip}
                      data-action="cancel-item"
                      onClick={() => cancelItem(item.itemId)}
                    >
                      取消
                    </button>
                  ) : null}
                </span>
                {state?.errorCode !== undefined ? (
                  <p
                    className="workflow-studio__batch-item-error"
                    role="status"
                  >
                    {itemFailureLabel(state)}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="workflow-studio__batch-empty">
          队列为空。文件名只会在加入后临时显示在这里。
        </p>
      )}

      <div className="workflow-studio__batch-footer">
        <div className="workflow-studio__batch-primary-actions">
          <button
            type="button"
            className="workflow-studio__primary"
            disabled={controlsDisabled || pending === 0}
            data-action="run-batch"
            onClick={() => void runBatch()}
          >
            {busy ? "正在串行处理" : `开始处理 ${pending} 项`}
          </button>
          <button
            type="button"
            disabled={!busy && !buildingZip}
            data-action="cancel-batch"
            onClick={cancelBatch}
          >
            取消全部
          </button>
          <button
            type="button"
            disabled={snapshot.items.length === 0}
            data-action="clear-batch"
            onClick={clearBatch}
          >
            清空队列
          </button>
        </div>
        <div className="workflow-studio__batch-export-actions">
          <button
            type="button"
            disabled={controlsDisabled || succeeded === 0}
            data-action="download-zip"
            onClick={() => void downloadZip()}
          >
            {buildingZip ? "正在打包" : "下载结果 ZIP"}
          </button>
          <button
            type="button"
            disabled={busy || buildingZip || snapshot.items.length === 0}
            data-action="download-receipt"
            onClick={downloadReceipt}
          >
            下载隐私回执
          </button>
        </div>
      </div>

      <div
        id={feedbackId}
        className={`workflow-studio__batch-feedback is-${feedback.kind}`}
        role={feedback.kind === "error" ? "alert" : "status"}
        aria-live="polite"
        aria-atomic="true"
        data-batch-feedback={feedback.kind}
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
    </section>
  );
}

export { WorkflowBatchPanel };

import { useId, useMemo, useState } from "react";

import {
  ToolWorkspace,
  ToolWorkspaceAction,
  ToolWorkspaceActions,
  ToolWorkspaceHeader,
  ToolWorkspaceRegion,
} from "../ToolWorkspace";
import {
  countTextLines,
  diffTextLines,
  getTextByteLength,
  TEXT_DIFF_LIMITS,
  type SideBySideRow,
  type TextDiffEntry,
  type TextDiffSide,
  type TextDiffSuccess,
} from "../../tools/text-diff";

const SAMPLE_ORIGINAL = `const config = {
  theme: "light",
  timeout: 3000,
  retry: 1,
};`;

const SAMPLE_REVISED = `const config = {
  theme: "dark",
  timeout: 5000,
  retry: 2,
  cache: true,
};`;

type DiffView = "unified" | "side-by-side";

type Feedback =
  | { kind: "idle"; message: string }
  | { kind: "success"; message: string }
  | { kind: "error"; message: string; side?: TextDiffSide };

type InputMetrics = {
  bytes: number;
  lines: number;
  overBytes: boolean;
  overLines: boolean;
};

const idleFeedback: Feedback = {
  kind: "idle",
  message: "文本只在当前浏览器标签页内比较，不会上传或保存。",
};

function getInputMetrics(value: string): InputMetrics {
  const bytes = getTextByteLength(value);
  const lines = countTextLines(value);
  return {
    bytes,
    lines,
    overBytes: bytes > TEXT_DIFF_LIMITS.maxBytesPerInput,
    overLines: lines > TEXT_DIFF_LIMITS.maxLinesPerInput,
  };
}

function displayBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KiB`;
}

function displayDuration(milliseconds: number): string {
  if (milliseconds < 1) return "<1 ms";
  if (milliseconds < 10) return `${milliseconds.toFixed(1)} ms`;
  return `${Math.round(milliseconds)} ms`;
}

function metricsLabel(metrics: InputMetrics): string {
  return `${metrics.lines.toLocaleString("zh-CN")} 行 · ${displayBytes(metrics.bytes)}`;
}

function typeLabel(type: TextDiffEntry["type"]): string {
  if (type === "added") return "新增";
  if (type === "removed") return "删除";
  return "未变";
}

function sideRowLabel(type: SideBySideRow["type"]): string {
  if (type === "changed") return "修改";
  return typeLabel(type);
}

function copyToClipboard(value: string): Promise<void> {
  if (!navigator.clipboard?.writeText) {
    return Promise.reject(new Error("Clipboard API unavailable"));
  }
  return navigator.clipboard.writeText(value);
}

function UnifiedDiff({ entries }: { entries: readonly TextDiffEntry[] }) {
  return (
    <div
      className="text-diff-tool__diff-table text-diff-tool__diff-table--unified"
      role="table"
      aria-label="统一差异视图"
    >
      <div className="text-diff-tool__unified-row is-head" role="row">
        <span role="columnheader">原行</span>
        <span role="columnheader">新行</span>
        <span role="columnheader">类型</span>
        <span role="columnheader">内容</span>
      </div>
      <div role="rowgroup">
        {entries.map((entry, index) => {
          const text = entry.revised?.text ?? entry.original?.text ?? "";
          const marker =
            entry.type === "added" ? "+" : entry.type === "removed" ? "−" : "";
          return (
            <div
              className={`text-diff-tool__unified-row is-${entry.type}`}
              role="row"
              key={`${entry.type}-${entry.original?.lineNumber ?? "x"}-${entry.revised?.lineNumber ?? "x"}-${index}`}
            >
              <span className="text-diff-tool__line-number" role="cell">
                {entry.original?.lineNumber ?? ""}
              </span>
              <span className="text-diff-tool__line-number" role="cell">
                {entry.revised?.lineNumber ?? ""}
              </span>
              <span
                className="text-diff-tool__marker"
                role="cell"
                aria-label={typeLabel(entry.type)}
              >
                {marker}
              </span>
              <code className="text-diff-tool__code" role="cell">
                {text || " "}
              </code>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SideBySideDiff({ rows }: { rows: readonly SideBySideRow[] }) {
  return (
    <div
      className="text-diff-tool__diff-table text-diff-tool__diff-table--split"
      role="table"
      aria-label="并排差异视图"
    >
      <div className="text-diff-tool__split-row is-head" role="row">
        <span role="columnheader">原文</span>
        <span role="columnheader">新文本</span>
      </div>
      <div role="rowgroup">
        {rows.map((row, index) => (
          <div
            className={`text-diff-tool__split-row is-${row.type}`}
            role="row"
            aria-label={`${sideRowLabel(row.type)}行`}
            key={`${row.type}-${row.original?.lineNumber ?? "x"}-${row.revised?.lineNumber ?? "x"}-${index}`}
          >
            <div
              className={`text-diff-tool__split-cell ${row.original ? "has-content" : "is-empty"}`}
              role="cell"
            >
              <span className="text-diff-tool__line-number">
                {row.original?.lineNumber ?? ""}
              </span>
              <code className="text-diff-tool__code">
                {row.original?.text || (row.original ? " " : "")}
              </code>
            </div>
            <div
              className={`text-diff-tool__split-cell ${row.revised ? "has-content" : "is-empty"}`}
              role="cell"
            >
              <span className="text-diff-tool__line-number">
                {row.revised?.lineNumber ?? ""}
              </span>
              <code className="text-diff-tool__code">
                {row.revised?.text || (row.revised ? " " : "")}
              </code>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function TextDiffTool() {
  const titleId = useId();
  const originalId = useId();
  const revisedId = useId();
  const originalHelpId = useId();
  const revisedHelpId = useId();
  const feedbackId = useId();
  const resultId = useId();

  const [original, setOriginal] = useState("");
  const [revised, setRevised] = useState("");
  const [view, setView] = useState<DiffView>("unified");
  const [ignoreWhitespace, setIgnoreWhitespace] = useState(false);
  const [ignoreCase, setIgnoreCase] = useState(false);
  const [result, setResult] = useState<TextDiffSuccess | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(idleFeedback);

  const originalMetrics = useMemo(() => getInputMetrics(original), [original]);
  const revisedMetrics = useMemo(() => getInputMetrics(revised), [revised]);
  const originalInvalid =
    originalMetrics.overBytes ||
    originalMetrics.overLines ||
    (feedback.kind === "error" && feedback.side === "original");
  const revisedInvalid =
    revisedMetrics.overBytes ||
    revisedMetrics.overLines ||
    (feedback.kind === "error" && feedback.side === "revised");
  const isAnyInputOverLimit =
    originalMetrics.overBytes ||
    originalMetrics.overLines ||
    revisedMetrics.overBytes ||
    revisedMetrics.overLines;
  const canCompare =
    (original.length > 0 || revised.length > 0) && !isAnyInputOverLimit;

  function updateInput(value: string, side: TextDiffSide) {
    if (side === "original") setOriginal(value);
    else setRevised(value);
    setResult(null);

    const metrics = getInputMetrics(value);
    if (metrics.overBytes) {
      setFeedback({
        kind: "error",
        side,
        message: `${side === "original" ? "原文" : "新文本"}为 ${displayBytes(metrics.bytes)}，超过每侧 512 KiB 上限。`,
      });
    } else if (metrics.overLines) {
      setFeedback({
        kind: "error",
        side,
        message: `${side === "original" ? "原文" : "新文本"}有 ${metrics.lines.toLocaleString("zh-CN")} 行，超过每侧 5,000 行上限。`,
      });
    } else {
      setFeedback(idleFeedback);
    }
  }

  function invalidateResult(message: string) {
    setResult(null);
    setFeedback({ kind: "idle", message });
  }

  function compare() {
    if (!original.length && !revised.length) {
      setFeedback({
        kind: "error",
        message: "请至少在一侧输入需要比较的文本。",
      });
      return;
    }

    const startedAt = performance.now();
    const nextResult = diffTextLines(original, revised, {
      ignoreWhitespace,
      ignoreCase,
    });
    const duration = displayDuration(performance.now() - startedAt);

    if (!nextResult.ok) {
      setResult(null);
      setFeedback({
        kind: "error",
        side: nextResult.error.side,
        message: nextResult.error.message,
      });
      return;
    }

    setResult(nextResult);
    const differences = nextResult.stats.added + nextResult.stats.removed;
    setFeedback({
      kind: "success",
      message:
        differences === 0
          ? `比较完成，用时 ${duration}；当前选项下两侧内容一致。`
          : `比较完成，用时 ${duration}；发现 ${nextResult.stats.changedBlocks} 个差异块。`,
    });
  }

  function handleComparisonShortcut(
    event: React.KeyboardEvent<HTMLTextAreaElement>,
  ) {
    if (
      (event.ctrlKey || event.metaKey) &&
      event.key === "Enter" &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      compare();
    }
  }

  async function copyDiff() {
    if (!result) return;
    try {
      await copyToClipboard(result.unified);
      setFeedback({ kind: "success", message: "统一差异已复制到剪贴板。" });
    } catch {
      setFeedback({
        kind: "error",
        message: "复制失败，请在差异结果中手动选择并复制。",
      });
    }
  }

  function downloadDiff() {
    if (!result) return;
    const blobUrl = URL.createObjectURL(
      new Blob([result.unified], { type: "text/plain;charset=utf-8" }),
    );
    const link = document.createElement("a");
    link.href = blobUrl;
    link.download = "text-changes.diff";
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(blobUrl), 0);
    setFeedback({ kind: "success", message: "已下载 text-changes.diff。" });
  }

  function swapInputs() {
    setOriginal(revised);
    setRevised(original);
    invalidateResult("原文与新文本已交换，请重新比较。");
  }

  function loadSample() {
    setOriginal(SAMPLE_ORIGINAL);
    setRevised(SAMPLE_REVISED);
    invalidateResult("示例已载入，可以开始比较。");
  }

  function clearWorkspace() {
    setOriginal("");
    setRevised("");
    setResult(null);
    setFeedback({ kind: "idle", message: "两侧输入和差异结果已清空。" });
  }

  return (
    <ToolWorkspace
      toolId="text-diff"
      titleId={titleId}
      className="text-diff-tool"
    >
      <ToolWorkspaceHeader className="text-diff-tool__heading">
        <div>
          <p className="eyebrow">交互区域</p>
          <h2 id={titleId}>文本差异对比</h2>
        </div>
        <span className="limit-label">每侧 512 KiB / 5,000 行</span>
      </ToolWorkspaceHeader>

      <div className="text-diff-tool__toolbar" aria-label="差异对比选项">
        <fieldset className="text-diff-tool__view-options">
          <legend>结果视图</legend>
          <div className="text-diff-tool__segments">
            {(
              [
                ["unified", "统一视图"],
                ["side-by-side", "并排视图"],
              ] as const
            ).map(([value, label]) => (
              <label key={value}>
                <input
                  type="radio"
                  name="text-diff-view"
                  value={value}
                  checked={view === value}
                  onChange={() => setView(value)}
                  aria-controls={resultId}
                />
                <span>{label}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className="text-diff-tool__compare-options">
          <legend>比较规则</legend>
          <div>
            <label>
              <input
                type="checkbox"
                checked={ignoreWhitespace}
                onChange={(event) => {
                  setIgnoreWhitespace(event.currentTarget.checked);
                  invalidateResult("比较规则已更新，请重新比较。");
                }}
              />
              <span>忽略空白</span>
            </label>
            <label>
              <input
                type="checkbox"
                checked={ignoreCase}
                onChange={(event) => {
                  setIgnoreCase(event.currentTarget.checked);
                  invalidateResult("比较规则已更新，请重新比较。");
                }}
              />
              <span>忽略大小写</span>
            </label>
          </div>
        </fieldset>

        <p className="text-diff-tool__shortcut">
          <kbd>Ctrl</kbd>/<kbd>⌘</kbd> + <kbd>Enter</kbd> 开始比较
        </p>
      </div>

      <ToolWorkspaceRegion region="input" className="text-diff-tool__inputs">
        <div className="text-diff-tool__editor">
          <div className="text-diff-tool__editor-head">
            <label htmlFor={originalId}>原文</label>
            <span className={originalInvalid ? "is-over" : undefined}>
              {metricsLabel(originalMetrics)}
            </span>
          </div>
          <textarea
            id={originalId}
            className="text-diff-tool__textarea"
            value={original}
            onChange={(event) =>
              updateInput(event.currentTarget.value, "original")
            }
            onKeyDown={handleComparisonShortcut}
            aria-describedby={`${originalHelpId} ${feedbackId}`}
            aria-errormessage={originalInvalid ? feedbackId : undefined}
            aria-invalid={originalInvalid || undefined}
            placeholder="粘贴原始文本"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            wrap="off"
            data-privacy-canary-input
          />
          <p id={originalHelpId} className="text-diff-tool__editor-help">
            作为修改前的版本；换行符会统一后按行比较。
          </p>
        </div>

        <div className="text-diff-tool__editor">
          <div className="text-diff-tool__editor-head">
            <label htmlFor={revisedId}>新文本</label>
            <span className={revisedInvalid ? "is-over" : undefined}>
              {metricsLabel(revisedMetrics)}
            </span>
          </div>
          <textarea
            id={revisedId}
            className="text-diff-tool__textarea"
            value={revised}
            onChange={(event) =>
              updateInput(event.currentTarget.value, "revised")
            }
            onKeyDown={handleComparisonShortcut}
            aria-describedby={`${revisedHelpId} ${feedbackId}`}
            aria-errormessage={revisedInvalid ? feedbackId : undefined}
            aria-invalid={revisedInvalid || undefined}
            placeholder="粘贴修改后的文本"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            wrap="off"
            data-privacy-canary-input
          />
          <p id={revisedHelpId} className="text-diff-tool__editor-help">
            作为修改后的版本；差异内容始终以纯文本呈现。
          </p>
        </div>
      </ToolWorkspaceRegion>

      <div
        id={feedbackId}
        className={`text-diff-tool__feedback text-diff-tool__feedback--${feedback.kind}`}
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

      <ToolWorkspaceRegion
        id={resultId}
        region="output"
        className="text-diff-tool__result"
        aria-label="差异结果"
      >
        {result ? (
          <>
            <div className="text-diff-tool__result-head">
              <div>
                <p className="eyebrow">比较结果</p>
                <h3>
                  {result.stats.added + result.stats.removed
                    ? "发现差异"
                    : "内容一致"}
                </h3>
              </div>
              <ul aria-label="差异统计">
                <li>
                  <strong>{result.stats.added}</strong> 新增
                </li>
                <li>
                  <strong>{result.stats.removed}</strong> 删除
                </li>
                <li>
                  <strong>{result.stats.unchanged}</strong> 未变
                </li>
              </ul>
            </div>
            <div
              className="text-diff-tool__diff-scroll"
              tabIndex={0}
              aria-label={`${view === "unified" ? "统一" : "并排"}差异内容，可滚动`}
            >
              {view === "unified" ? (
                <UnifiedDiff entries={result.entries} />
              ) : (
                <SideBySideDiff rows={result.sideBySide} />
              )}
            </div>
          </>
        ) : (
          <div className="text-diff-tool__empty-result">
            <span aria-hidden="true">±</span>
            <div>
              <h3>等待比较</h3>
              <p>
                输入两份文本后开始比较；复杂度超过安全预算时会停止并提示分段处理。
              </p>
            </div>
          </div>
        )}
      </ToolWorkspaceRegion>

      <ToolWorkspaceActions className="text-diff-tool__actions">
        <div className="text-diff-tool__actions-primary">
          <ToolWorkspaceAction
            action="execute"
            className="button button--primary"
            type="button"
            onClick={compare}
            disabled={!canCompare}
            data-privacy-canary-action
          >
            开始比较
          </ToolWorkspaceAction>
          <ToolWorkspaceAction
            action="swap"
            className="button button--secondary"
            type="button"
            onClick={swapInputs}
            disabled={!original && !revised}
          >
            交换两侧
          </ToolWorkspaceAction>
        </div>
        <div className="text-diff-tool__actions-secondary">
          <ToolWorkspaceAction
            action="copy"
            className="button button--secondary"
            type="button"
            onClick={copyDiff}
            disabled={!result}
          >
            复制差异
          </ToolWorkspaceAction>
          <ToolWorkspaceAction
            action="download"
            className="button button--secondary"
            type="button"
            onClick={downloadDiff}
            disabled={!result}
          >
            下载 .diff
          </ToolWorkspaceAction>
          <ToolWorkspaceAction
            action="example"
            className="button button--quiet"
            type="button"
            onClick={loadSample}
          >
            载入示例
          </ToolWorkspaceAction>
          <ToolWorkspaceAction
            action="clear"
            className="button button--quiet"
            type="button"
            onClick={clearWorkspace}
            disabled={!original && !revised && !result}
          >
            清空
          </ToolWorkspaceAction>
        </div>
      </ToolWorkspaceActions>
    </ToolWorkspace>
  );
}

import { useId, useMemo, useState } from "react";

import {
  formatJson,
  minifyJson,
  type JsonIndent,
} from "../../tools/json-formatter";

import "./JsonFormatterTool.css";

const MAX_INPUT_BYTES = 2 * 1024 * 1024;

const SAMPLE_JSON = `{
  "project": "Online Tools Hub",
  "privacy": {
    "processing": "local",
    "uploads": false
  },
  "tools": ["JSON 格式化", "Base64 编解码", "URL 编解码"],
  "version": 1
}`;

type TransformMode = "format" | "minify";

type JsonIssue = {
  message: string;
  line: number;
  column: number;
  context: string;
  pointer: string;
};

type Feedback =
  | { kind: "idle"; message: string }
  | { kind: "success"; message: string }
  | {
      kind: "error";
      message: string;
      issue?: JsonIssue;
      inputRelated?: boolean;
    };

const idleFeedback: Feedback = {
  kind: "idle",
  message: "内容只在当前浏览器标签页内处理。",
};

function getUtf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function displayBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

function displayDuration(milliseconds: number): string {
  if (milliseconds < 1) return "<1 ms";
  if (milliseconds < 10) return `${milliseconds.toFixed(1)} ms`;
  return `${Math.round(milliseconds)} ms`;
}

function copyToClipboard(value: string): Promise<void> {
  if (!navigator.clipboard?.writeText) {
    return Promise.reject(new Error("当前浏览器不支持剪贴板 API"));
  }

  return navigator.clipboard.writeText(value);
}

export default function JsonFormatterTool() {
  const titleId = useId();
  const inputId = useId();
  const outputId = useId();
  const feedbackId = useId();
  const inputHelpId = useId();

  const [input, setInput] = useState("");
  const [output, setOutput] = useState("");
  const [indent, setIndent] = useState<JsonIndent>(2);
  const [lastMode, setLastMode] = useState<TransformMode>("format");
  const [feedback, setFeedback] = useState<Feedback>(idleFeedback);

  const inputBytes = useMemo(() => getUtf8ByteLength(input), [input]);
  const outputBytes = useMemo(() => getUtf8ByteLength(output), [output]);
  const isOverLimit = inputBytes > MAX_INPUT_BYTES;
  const hasInputError =
    isOverLimit || (feedback.kind === "error" && feedback.inputRelated);
  const canTransform = input.trim().length > 0 && !isOverLimit;

  function updateInput(nextInput: string) {
    const nextBytes = getUtf8ByteLength(nextInput);

    setInput(nextInput);
    setOutput("");

    if (nextBytes > MAX_INPUT_BYTES) {
      setFeedback({
        kind: "error",
        message: `输入为 ${displayBytes(nextBytes)}，已超过 2 MiB 上限。`,
        inputRelated: true,
      });
      return;
    }

    setFeedback(idleFeedback);
  }

  function runTransform(mode: TransformMode) {
    if (!input.trim()) {
      setFeedback({
        kind: "error",
        message: "请先输入需要处理的 JSON。",
        inputRelated: true,
      });
      return;
    }

    if (isOverLimit) {
      setFeedback({
        kind: "error",
        message: "输入超过 2 MiB 上限，请缩减内容后再试。",
        inputRelated: true,
      });
      return;
    }

    const startedAt = performance.now();
    const result =
      mode === "format" ? formatJson(input, indent) : minifyJson(input);
    const duration = displayDuration(performance.now() - startedAt);

    if (!result.ok) {
      setOutput("");
      setFeedback({
        kind: "error",
        message: `JSON 无效：第 ${result.error.line} 行，第 ${result.error.column} 列。`,
        issue: result.error,
        inputRelated: true,
      });
      return;
    }

    setOutput(result.value);
    setLastMode(mode);
    setFeedback({
      kind: "success",
      message:
        mode === "format"
          ? `格式化完成，用时 ${duration}，使用${indent === "tab" ? " Tab" : ` ${indent} 个空格`}缩进。`
          : `压缩完成，用时 ${duration}，已移除不必要的空白字符。`,
    });
  }

  async function copyOutput() {
    if (!output) return;

    try {
      await copyToClipboard(output);
      setFeedback({ kind: "success", message: "结果已复制到剪贴板。" });
    } catch {
      setFeedback({
        kind: "error",
        message: "复制失败，请选中输出内容后手动复制。",
      });
    }
  }

  function downloadOutput() {
    if (!output) return;

    const blobUrl = URL.createObjectURL(
      new Blob([output], { type: "application/json;charset=utf-8" }),
    );
    const link = document.createElement("a");
    link.href = blobUrl;
    link.download = lastMode === "minify" ? "minified.json" : "formatted.json";
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(blobUrl), 0);

    setFeedback({ kind: "success", message: `已下载 ${link.download}。` });
  }

  function clearWorkspace() {
    setInput("");
    setOutput("");
    setFeedback({ kind: "idle", message: "输入和结果已清空。" });
  }

  function loadSample() {
    setInput(SAMPLE_JSON);
    setOutput("");
    setFeedback({ kind: "idle", message: "示例已载入，可以开始格式化。" });
  }

  return (
    <section
      className="tool-workspace json-tool"
      aria-labelledby={titleId}
      data-local-processing="true"
    >
      <div className="tool-workspace__head json-tool__heading">
        <div>
          <p className="eyebrow">交互区域</p>
          <h2 id={titleId}>JSON 格式化与校验</h2>
        </div>
        <span className="limit-label">输入上限 2 MiB</span>
      </div>

      <div className="json-tool__toolbar" aria-label="JSON 处理选项">
        <fieldset className="json-tool__indent">
          <legend>格式化缩进</legend>
          <div className="json-tool__segments">
            {(
              [
                [2, "2 空格"],
                [4, "4 空格"],
                ["tab", "Tab"],
              ] as const
            ).map(([value, label]) => (
              <label key={value}>
                <input
                  type="radio"
                  name="json-indentation"
                  value={value}
                  checked={indent === value}
                  onChange={() => setIndent(value)}
                />
                <span>{label}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <p className="json-tool__shortcut">
          <kbd>Ctrl</kbd>/<kbd>⌘</kbd> + <kbd>Enter</kbd> 快速格式化
        </p>
      </div>

      <div className="json-tool__editors">
        <section
          className="json-tool__editor"
          aria-labelledby={`${inputId}-label`}
        >
          <div className="json-tool__editor-head">
            <label id={`${inputId}-label`} htmlFor={inputId}>
              输入
            </label>
            <span
              className={
                isOverLimit ? "json-tool__count is-over" : "json-tool__count"
              }
            >
              {displayBytes(inputBytes)} / 2 MiB
            </span>
          </div>
          <textarea
            id={inputId}
            className="json-tool__textarea"
            value={input}
            onChange={(event) => updateInput(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (
                (event.ctrlKey || event.metaKey) &&
                event.key === "Enter" &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                runTransform("format");
              }
            }}
            aria-describedby={`${inputHelpId} ${feedbackId}`}
            aria-errormessage={hasInputError ? feedbackId : undefined}
            aria-invalid={hasInputError || undefined}
            placeholder='粘贴 JSON，例如 {"hello": "world"}'
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            wrap="off"
            data-privacy-canary-input
          />
          <p id={inputHelpId} className="json-tool__editor-help">
            支持对象、数组和任意合法 JSON 值；不会自动上传或保存。
          </p>
        </section>

        <section
          className="json-tool__editor"
          aria-labelledby={`${outputId}-label`}
        >
          <div className="json-tool__editor-head">
            <label id={`${outputId}-label`} htmlFor={outputId}>
              输出
            </label>
            <span className="json-tool__count">
              {output ? displayBytes(outputBytes) : "等待处理"}
            </span>
          </div>
          <textarea
            id={outputId}
            className="json-tool__textarea json-tool__textarea--output"
            value={output}
            placeholder="处理结果会以纯文本显示在这里"
            readOnly
            spellCheck={false}
            wrap="off"
          />
          <p className="json-tool__editor-help">
            输出使用纯文本呈现，不执行或渲染其中的任何内容。
          </p>
        </section>
      </div>

      <div
        id={feedbackId}
        className={`json-tool__feedback json-tool__feedback--${feedback.kind}`}
        role={feedback.kind === "error" ? "alert" : "status"}
        aria-live={feedback.kind === "error" ? "assertive" : "polite"}
        aria-atomic="true"
      >
        <span className="json-tool__feedback-mark" aria-hidden="true">
          {feedback.kind === "error"
            ? "!"
            : feedback.kind === "success"
              ? "✓"
              : "i"}
        </span>
        <div>
          <p>{feedback.message}</p>
          {feedback.kind === "error" && feedback.issue ? (
            <details>
              <summary>{feedback.issue.message}</summary>
              <pre>{`${feedback.issue.context}\n${feedback.issue.pointer}`}</pre>
            </details>
          ) : null}
        </div>
      </div>

      <div className="workspace-actions json-tool__actions">
        <div className="json-tool__actions-primary">
          <button
            className="button button--primary"
            type="button"
            onClick={() => runTransform("format")}
            disabled={!canTransform}
            data-privacy-canary-action
          >
            格式化
          </button>
          <button
            className="button button--secondary"
            type="button"
            onClick={() => runTransform("minify")}
            disabled={!canTransform}
          >
            压缩
          </button>
        </div>
        <div className="json-tool__actions-secondary">
          <button
            className="button button--secondary"
            type="button"
            onClick={copyOutput}
            disabled={!output}
          >
            复制结果
          </button>
          <button
            className="button button--secondary"
            type="button"
            onClick={downloadOutput}
            disabled={!output}
          >
            下载 .json
          </button>
          <button
            className="button button--quiet"
            type="button"
            onClick={loadSample}
          >
            载入示例
          </button>
          <button
            className="button button--quiet"
            type="button"
            onClick={clearWorkspace}
            disabled={!input && !output}
          >
            清空
          </button>
        </div>
      </div>
    </section>
  );
}

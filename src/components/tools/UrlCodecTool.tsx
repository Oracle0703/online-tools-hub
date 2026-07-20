import { useId, useMemo, useState } from "react";

import {
  ToolWorkspace,
  ToolWorkspaceAction,
  ToolWorkspaceActions,
  ToolWorkspaceHeader,
  ToolWorkspaceRegion,
} from "../ToolWorkspace";
import ToolRelay from "../ToolRelay";
import {
  transformUrl,
  type UrlCodecErrorDetails,
  type UrlCodecMode,
  type UrlCodecOperation,
} from "../../tools/url-codec";

import "./UrlCodecTool.css";

const MAX_INPUT_BYTES = 2 * 1024 * 1024;

const SAMPLES: Record<UrlCodecMode, string> = {
  component: "搜索关键词：中文 + spaces & 100%",
  url: "https://example.com/搜索/工具?q=中文 URL+工具&source=在线#说明",
};

type Feedback =
  | { kind: "idle"; message: string }
  | { kind: "success"; message: string }
  | {
      kind: "error";
      message: string;
      issue?: UrlCodecErrorDetails;
      inputRelated?: boolean;
    };

const idleFeedback: Feedback = {
  kind: "idle",
  message: "内容只在当前浏览器标签页内处理，不会发送网络请求。",
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
    return Promise.reject(new Error("Clipboard API unavailable"));
  }

  return navigator.clipboard.writeText(value);
}

export default function UrlCodecTool() {
  const titleId = useId();
  const inputId = useId();
  const outputId = useId();
  const feedbackId = useId();
  const inputHelpId = useId();
  const modeHelpId = useId();

  const [input, setInput] = useState("");
  const [output, setOutput] = useState("");
  const [mode, setMode] = useState<UrlCodecMode>("component");
  const [formEncoding, setFormEncoding] = useState(false);
  const [lastOperation, setLastOperation] = useState<UrlCodecOperation | null>(
    null,
  );
  const [feedback, setFeedback] = useState<Feedback>(idleFeedback);

  const inputBytes = useMemo(() => getUtf8ByteLength(input), [input]);
  const outputBytes = useMemo(() => getUtf8ByteLength(output), [output]);
  const isOverLimit = inputBytes > MAX_INPUT_BYTES;
  const hasInputError =
    isOverLimit || (feedback.kind === "error" && feedback.inputRelated);
  const canTransform = input.length > 0 && !isOverLimit;
  const canSwap = output.length > 0 && outputBytes <= MAX_INPUT_BYTES;

  function updateInput(nextInput: string) {
    const nextBytes = getUtf8ByteLength(nextInput);
    setInput(nextInput);
    setOutput("");
    setLastOperation(null);

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

  function selectMode(nextMode: UrlCodecMode) {
    setMode(nextMode);
    setOutput("");
    setLastOperation(null);
    setFeedback({
      kind: "idle",
      message:
        nextMode === "component"
          ? "组件模式会编码 URL 分隔符，适合路径段或单个参数值。"
          : "完整 URL 模式保留结构分隔符，只做文本转换且不会访问地址。",
    });
  }

  function runTransform(operation: UrlCodecOperation) {
    if (!input.length) {
      setFeedback({
        kind: "error",
        message: "请先输入需要处理的 URL 文本。",
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
    const result = transformUrl(input, operation, mode, { formEncoding });
    const duration = displayDuration(performance.now() - startedAt);

    if (!result.ok) {
      setOutput("");
      setLastOperation(null);
      setFeedback({
        kind: "error",
        message: `处理失败：第 ${result.error.line} 行，第 ${result.error.column} 列。`,
        issue: result.error,
        inputRelated: true,
      });
      return;
    }

    setOutput(result.value);
    setLastOperation(operation);
    setFeedback({
      kind: "success",
      message: `${operation === "encode" ? "编码" : "解码"}完成，用时 ${duration}。${
        mode === "url" ? "未打开或请求输入地址。" : ""
      }`,
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

  function swapValues() {
    if (!canSwap) return;

    const previousInput = input;
    setInput(output);
    setOutput(previousInput);
    setLastOperation(null);
    setFeedback({ kind: "idle", message: "输入与结果已交换。" });
  }

  function loadSample() {
    setInput(SAMPLES[mode]);
    setOutput("");
    setLastOperation(null);
    setFeedback({ kind: "idle", message: "示例已载入，可以开始处理。" });
  }

  function clearWorkspace() {
    setInput("");
    setOutput("");
    setLastOperation(null);
    setFeedback({ kind: "idle", message: "输入和结果已清空。" });
  }

  return (
    <ToolWorkspace toolId="url-codec" titleId={titleId} className="url-tool">
      <ToolWorkspaceHeader className="url-tool__heading">
        <div>
          <p className="eyebrow">交互区域</p>
          <h2 id={titleId}>URL 编码与解码</h2>
        </div>
        <span className="limit-label">输入上限 2 MiB</span>
      </ToolWorkspaceHeader>

      <div className="url-tool__toolbar" aria-label="URL 编解码选项">
        <fieldset className="url-tool__mode" aria-describedby={modeHelpId}>
          <legend>处理范围</legend>
          <div className="url-tool__segments">
            {(
              [
                ["component", "URL 组件"],
                ["url", "完整 URL"],
              ] as const
            ).map(([value, label]) => (
              <label key={value}>
                <input
                  type="radio"
                  name="url-codec-mode"
                  value={value}
                  checked={mode === value}
                  onChange={() => selectMode(value)}
                />
                <span>{label}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <label className="url-tool__form-option">
          <input
            type="checkbox"
            checked={formEncoding}
            onChange={(event) => {
              setFormEncoding(event.currentTarget.checked);
              setOutput("");
              setLastOperation(null);
              setFeedback({
                kind: "idle",
                message: event.currentTarget.checked
                  ? "已启用表单规则：编码时空格变为 +，解码时 + 变为空格。"
                  : "已使用标准 URL 规则：空格编码为 %20，字面 + 保持原义。",
              });
            }}
          />
          <span>表单规则（空格 ↔ +）</span>
        </label>
      </div>

      <p id={modeHelpId} className="url-tool__mode-help">
        {mode === "component"
          ? "组件模式适合单个路径段、参数名或参数值；默认会把 + 编码为 %2B。"
          : "完整 URL 模式保留 : / ? # & = 等结构和已有的有效 %XX 转义；表单规则仅作用于查询参数。"}
      </p>

      <div className="url-tool__editors">
        <ToolWorkspaceRegion region="input" className="url-tool__editor">
          <div className="url-tool__editor-head">
            <label htmlFor={inputId}>输入</label>
            <span
              className={
                isOverLimit ? "url-tool__count is-over" : "url-tool__count"
              }
            >
              {displayBytes(inputBytes)} / 2 MiB
            </span>
          </div>
          <textarea
            id={inputId}
            className="url-tool__textarea"
            value={input}
            onChange={(event) => updateInput(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (
                (event.ctrlKey || event.metaKey) &&
                event.key === "Enter" &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                runTransform(event.shiftKey ? "decode" : "encode");
              }
            }}
            aria-describedby={`${inputHelpId} ${feedbackId}`}
            aria-errormessage={hasInputError ? feedbackId : undefined}
            aria-invalid={hasInputError || undefined}
            placeholder={
              mode === "component"
                ? "输入路径段或参数值，例如 中文 + 空格"
                : "输入完整地址，例如 https://example.com/搜索?q=中文"
            }
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            wrap="off"
            data-privacy-canary-input
          />
          <p id={inputHelpId} className="url-tool__editor-help">
            <kbd>Ctrl</kbd>/<kbd>⌘</kbd> + <kbd>Enter</kbd> 编码；同时按住
            <kbd>Shift</kbd> 解码。所有处理均在本地完成。
          </p>
        </ToolWorkspaceRegion>

        <ToolWorkspaceRegion region="output" className="url-tool__editor">
          <div className="url-tool__editor-head">
            <label htmlFor={outputId}>输出</label>
            <span className="url-tool__count">
              {output ? displayBytes(outputBytes) : "等待处理"}
            </span>
          </div>
          <textarea
            id={outputId}
            className="url-tool__textarea url-tool__textarea--output"
            value={output}
            placeholder="结果会以纯文本显示在这里"
            readOnly
            spellCheck={false}
            wrap="off"
          />
          <p className="url-tool__editor-help">
            输出不会变成可点击链接，也不会触发跳转、预览或网络请求。
          </p>
        </ToolWorkspaceRegion>
      </div>

      <div
        id={feedbackId}
        className={`url-tool__feedback url-tool__feedback--${feedback.kind}`}
        role={feedback.kind === "error" ? "alert" : "status"}
        aria-live={feedback.kind === "error" ? "assertive" : "polite"}
        aria-atomic="true"
      >
        <span className="url-tool__feedback-mark" aria-hidden="true">
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

      <ToolWorkspaceActions className="url-tool__actions">
        <div className="url-tool__actions-primary">
          <ToolWorkspaceAction
            action="execute"
            className="button button--primary"
            type="button"
            onClick={() => runTransform("encode")}
            disabled={!canTransform}
            data-privacy-canary-action
          >
            URL 编码
          </ToolWorkspaceAction>
          <ToolWorkspaceAction
            action="execute"
            className="button button--secondary"
            type="button"
            onClick={() => runTransform("decode")}
            disabled={!canTransform}
          >
            URL 解码
          </ToolWorkspaceAction>
        </div>
        <div className="url-tool__actions-secondary">
          <ToolWorkspaceAction
            action="swap"
            className="button button--secondary"
            type="button"
            onClick={swapValues}
            disabled={!canSwap}
            title={
              outputBytes > MAX_INPUT_BYTES
                ? "结果超过输入上限，无法交换"
                : undefined
            }
          >
            交换
          </ToolWorkspaceAction>
          <ToolWorkspaceAction
            action="copy"
            className="button button--secondary"
            type="button"
            onClick={copyOutput}
            disabled={!output}
          >
            复制结果
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
            disabled={!input && !output}
          >
            清空
          </ToolWorkspaceAction>
        </div>
      </ToolWorkspaceActions>

      {lastOperation === "decode" && output ? (
        <ToolRelay
          value={output}
          sourceLabel="URL 解码结果"
          targetSlug="query-params"
          targetLabel="查询参数解析"
        />
      ) : null}
    </ToolWorkspace>
  );
}

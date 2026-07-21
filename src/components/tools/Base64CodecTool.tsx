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
  decodeBase64,
  encodeBase64,
  type Base64Variant,
} from "../../tools/base64-codec";

const MAX_INPUT_BYTES = 2 * 1024 * 1024;
const SAMPLE_TEXT = `你好，Online Tools Hub! 👋
Base64 是编码，不是加密。`;

type TransformMode = "encode" | "decode";

type Feedback =
  | { kind: "idle"; message: string }
  | { kind: "success"; message: string }
  | { kind: "error"; message: string; inputRelated?: boolean };

const idleFeedback: Feedback = {
  kind: "idle",
  message: "内容只在当前浏览器标签页内处理，不会上传或保存。",
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

export default function Base64CodecTool() {
  const titleId = useId();
  const inputId = useId();
  const outputId = useId();
  const inputHelpId = useId();
  const feedbackId = useId();
  const operationName = useId();
  const variantName = useId();

  const [input, setInput] = useState("");
  const [output, setOutput] = useState("");
  const [mode, setMode] = useState<TransformMode>("encode");
  const [lastMode, setLastMode] = useState<TransformMode>("encode");
  const [variant, setVariant] = useState<Base64Variant>("standard");
  const [feedback, setFeedback] = useState<Feedback>(idleFeedback);

  const inputBytes = useMemo(() => getUtf8ByteLength(input), [input]);
  const outputBytes = useMemo(() => getUtf8ByteLength(output), [output]);
  const isOverLimit = inputBytes > MAX_INPUT_BYTES;
  const hasInputError =
    isOverLimit || (feedback.kind === "error" && feedback.inputRelated);
  const canTransform = input.length > 0 && !isOverLimit;
  const decodedFirstCharacter = output.trimStart().charAt(0);
  const decodedLooksLikeJson =
    mode === "decode" &&
    lastMode === "decode" &&
    (decodedFirstCharacter === "{" || decodedFirstCharacter === "[");

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

  function changeMode(nextMode: TransformMode) {
    setMode(nextMode);
    setOutput("");
    setFeedback({
      kind: "idle",
      message:
        nextMode === "encode"
          ? "编码模式：先按 UTF-8 转为字节，再生成 Base64 文本。"
          : "解码模式：严格校验 Base64，并拒绝无效 UTF-8。",
    });
  }

  function changeVariant(nextVariant: Base64Variant) {
    setVariant(nextVariant);
    setOutput("");
    setFeedback({
      kind: "idle",
      message:
        nextVariant === "standard"
          ? "已选择标准 Base64；解码时要求正确的 = 填充。"
          : "已选择 Base64URL；编码结果使用 -、_ 且省略末尾填充。",
    });
  }

  function runTransform() {
    if (!input.length) {
      setFeedback({
        kind: "error",
        message: "请先输入需要处理的文本。",
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

    if (mode === "encode") {
      let value: string;
      try {
        value = encodeBase64(input, variant);
      } catch (error) {
        setOutput("");
        setFeedback({
          kind: "error",
          message:
            error instanceof Error
              ? `编码失败：${error.message}`
              : "编码失败：输入包含无法转换为 UTF-8 的字符。",
          inputRelated: true,
        });
        return;
      }
      const duration = displayDuration(performance.now() - startedAt);

      setOutput(value);
      setLastMode("encode");
      setFeedback({
        kind: "success",
        message: `编码完成，用时 ${duration}；结果为${variant === "url" ? "无填充 Base64URL" : "标准 Base64"}。`,
      });
      return;
    }

    const result = decodeBase64(input, variant);
    const duration = displayDuration(performance.now() - startedAt);

    if (!result.ok) {
      setOutput("");
      setFeedback({
        kind: "error",
        message: `解码失败：${result.error.message}`,
        inputRelated: true,
      });
      return;
    }

    setOutput(result.value);
    setLastMode("decode");
    setFeedback({
      kind: "success",
      message: `解码完成，用时 ${duration}；结果是经过严格校验的 UTF-8 文本。`,
    });
  }

  function swapValues() {
    if (!output.length) return;

    const nextInput = output;
    const nextMode: TransformMode = lastMode === "encode" ? "decode" : "encode";
    const nextBytes = getUtf8ByteLength(nextInput);

    setInput(nextInput);
    setOutput(input);
    setMode(nextMode);

    if (nextBytes > MAX_INPUT_BYTES) {
      setFeedback({
        kind: "error",
        message: `交换后的输入为 ${displayBytes(nextBytes)}，已超过 2 MiB 上限。`,
        inputRelated: true,
      });
      return;
    }

    setFeedback({
      kind: "idle",
      message: `输入与结果已交换，并切换到${nextMode === "encode" ? "编码" : "解码"}模式。`,
    });
  }

  async function copyOutput() {
    if (!output.length) return;

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
    if (!output.length) return;

    const isEncoded = lastMode === "encode";
    const filename = isEncoded
      ? variant === "url"
        ? "encoded-base64url.txt"
        : "encoded-base64.txt"
      : "decoded-utf8.txt";
    const blobUrl = URL.createObjectURL(
      new Blob([output], { type: "text/plain;charset=utf-8" }),
    );
    const link = document.createElement("a");

    link.href = blobUrl;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(blobUrl), 0);

    setFeedback({ kind: "success", message: `已下载 ${filename}。` });
  }

  function loadSample() {
    const sample =
      mode === "encode" ? SAMPLE_TEXT : encodeBase64(SAMPLE_TEXT, variant);

    setInput(sample);
    setOutput("");
    setFeedback({
      kind: "idle",
      message: `已载入${mode === "encode" ? " UTF-8 文本" : variant === "url" ? " Base64URL" : "标准 Base64"}示例。`,
    });
  }

  function clearWorkspace() {
    setInput("");
    setOutput("");
    setFeedback({ kind: "idle", message: "输入和结果已清空。" });
  }

  const actionLabel =
    mode === "encode"
      ? variant === "url"
        ? "编码为 Base64URL"
        : "编码为 Base64"
      : variant === "url"
        ? "解码 Base64URL"
        : "解码 Base64";

  return (
    <ToolWorkspace
      toolId="base64-codec"
      titleId={titleId}
      className="base64-tool"
    >
      <ToolWorkspaceHeader className="base64-tool__heading">
        <div>
          <p className="eyebrow">交互区域</p>
          <h2 id={titleId}>Base64 / Base64URL 编码与解码</h2>
        </div>
        <span className="limit-label">输入上限 2 MiB</span>
      </ToolWorkspaceHeader>

      <aside className="base64-tool__notice" aria-label="Base64 安全提示">
        <span aria-hidden="true">!</span>
        <p>
          <strong>Base64 是编码，不是加密。</strong>
          请勿把密码、令牌或其他机密信息的安全性寄托在 Base64 上。
        </p>
      </aside>

      <div className="base64-tool__toolbar" aria-label="Base64 处理选项">
        <fieldset className="base64-tool__option">
          <legend>操作</legend>
          <div className="base64-tool__segments">
            {(
              [
                ["encode", "编码"],
                ["decode", "解码"],
              ] as const
            ).map(([value, label]) => (
              <label key={value}>
                <input
                  type="radio"
                  name={operationName}
                  value={value}
                  checked={mode === value}
                  onChange={() => changeMode(value)}
                />
                <span>{label}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className="base64-tool__option">
          <legend>格式</legend>
          <div className="base64-tool__segments">
            {(
              [
                ["standard", "标准 Base64"],
                ["url", "Base64URL"],
              ] as const
            ).map(([value, label]) => (
              <label key={value}>
                <input
                  type="radio"
                  name={variantName}
                  value={value}
                  checked={variant === value}
                  onChange={() => changeVariant(value)}
                />
                <span>{label}</span>
              </label>
            ))}
          </div>
        </fieldset>
      </div>

      <p className="base64-tool__shortcut">
        <kbd>Ctrl</kbd>/<kbd>⌘</kbd> + <kbd>Enter</kbd> 快速执行当前操作
      </p>

      <div className="base64-tool__editors">
        <ToolWorkspaceRegion region="input" className="base64-tool__editor">
          <div className="base64-tool__editor-head">
            <label htmlFor={inputId}>
              {mode === "encode" ? "UTF-8 输入" : "Base64 输入"}
            </label>
            <span
              className={
                isOverLimit
                  ? "base64-tool__count is-over"
                  : "base64-tool__count"
              }
            >
              {displayBytes(inputBytes)} / 2 MiB
            </span>
          </div>
          <textarea
            id={inputId}
            className="base64-tool__textarea"
            value={input}
            onChange={(event) => updateInput(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (
                (event.ctrlKey || event.metaKey) &&
                event.key === "Enter" &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                runTransform();
              }
            }}
            aria-describedby={`${inputHelpId} ${feedbackId}`}
            aria-errormessage={hasInputError ? feedbackId : undefined}
            aria-invalid={hasInputError || undefined}
            placeholder={
              mode === "encode"
                ? "输入 UTF-8 文本，支持中文、Emoji、换行和 NUL"
                : variant === "url"
                  ? "粘贴 Base64URL，例如 SGVsbG8"
                  : "粘贴标准 Base64，例如 SGVsbG8="
            }
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            wrap="off"
            data-privacy-canary-input
          />
          <p id={inputHelpId} className="base64-tool__editor-help">
            {mode === "encode"
              ? "文本会先按 UTF-8 转为字节；中文、Emoji、换行和 NUL 均可保留。"
              : "严格拒绝非法字符、错误填充、非规范填充位和无效 UTF-8。"}
          </p>
        </ToolWorkspaceRegion>

        <ToolWorkspaceRegion region="output" className="base64-tool__editor">
          <div className="base64-tool__editor-head">
            <label htmlFor={outputId}>
              {mode === "encode" ? "编码结果" : "UTF-8 结果"}
            </label>
            <span className="base64-tool__count">
              {output.length ? displayBytes(outputBytes) : "等待处理"}
            </span>
          </div>
          <textarea
            id={outputId}
            className="base64-tool__textarea base64-tool__textarea--output"
            value={output}
            placeholder="处理结果会以纯文本显示在这里"
            readOnly
            spellCheck={false}
            wrap="off"
          />
          <p className="base64-tool__editor-help">
            输出仅以纯文本呈现，不会被执行、渲染或自动写入剪贴板。
          </p>
        </ToolWorkspaceRegion>
      </div>

      <div
        id={feedbackId}
        className={`base64-tool__feedback base64-tool__feedback--${feedback.kind}`}
        role={feedback.kind === "error" ? "alert" : "status"}
        aria-live={feedback.kind === "error" ? "assertive" : "polite"}
        aria-atomic="true"
      >
        <span className="base64-tool__feedback-mark" aria-hidden="true">
          {feedback.kind === "error"
            ? "!"
            : feedback.kind === "success"
              ? "✓"
              : "i"}
        </span>
        <p>{feedback.message}</p>
      </div>

      <ToolWorkspaceActions className="base64-tool__actions">
        <div className="base64-tool__actions-primary">
          <ToolWorkspaceAction
            action="execute"
            className="button button--primary"
            type="button"
            onClick={runTransform}
            disabled={!canTransform}
            data-privacy-canary-action
          >
            {actionLabel}
          </ToolWorkspaceAction>
          <ToolWorkspaceAction
            action="swap"
            className="button button--secondary"
            type="button"
            onClick={swapValues}
            disabled={!output.length}
          >
            交换输入与结果
          </ToolWorkspaceAction>
        </div>
        <div className="base64-tool__actions-secondary">
          <ToolWorkspaceAction
            action="copy"
            className="button button--secondary"
            type="button"
            onClick={copyOutput}
            disabled={!output.length}
          >
            复制结果
          </ToolWorkspaceAction>
          <ToolWorkspaceAction
            action="download"
            className="button button--secondary"
            type="button"
            onClick={downloadOutput}
            disabled={!output.length}
          >
            下载 .txt
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
            disabled={!input.length && !output.length}
          >
            清空
          </ToolWorkspaceAction>
        </div>
      </ToolWorkspaceActions>

      {decodedLooksLikeJson ? (
        <ToolRelay
          value={output}
          sourceLabel="解码结果"
          targetSlug="json-formatter"
          targetLabel="JSON 格式化"
        />
      ) : null}
    </ToolWorkspace>
  );
}

import { useId, useMemo, useState } from "react";

import {
  ToolWorkspace,
  ToolWorkspaceAction,
  ToolWorkspaceActions,
  ToolWorkspaceHeader,
  ToolWorkspaceRegion,
} from "../ToolWorkspace";
import {
  MAX_YAML_JSON_INPUT_BYTES,
  transformYamlJson,
  type JsonOutputIndent,
  type YamlJsonDirection,
  type YamlJsonErrorDetails,
} from "../../tools/yaml-json-converter";

import "./YamlJsonConverterTool.css";

const SAMPLES: Record<YamlJsonDirection, string> = {
  "yaml-to-json": `project: Online Tools Hub
privacy:
  processing: 本地浏览器
  uploads: false
features:
  - YAML 转 JSON
  - 支持中文
  - 支持数组
maintainers:
  - name: 小明
    active: true`,
  "json-to-yaml": `{
  "project": "Online Tools Hub",
  "privacy": "本地处理",
  "features": ["JSON 转 YAML", "支持中文", "支持数组"],
  "ready": true
}`,
};

type Feedback =
  | { kind: "idle"; message: string }
  | { kind: "success"; message: string }
  | {
      kind: "error";
      message: string;
      issue?: YamlJsonErrorDetails;
      inputRelated?: boolean;
    };

const idleFeedback: Feedback = {
  kind: "idle",
  message: "内容只在当前浏览器标签页内处理，不会上传或持久化保存。",
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

function oppositeDirection(direction: YamlJsonDirection): YamlJsonDirection {
  return direction === "yaml-to-json" ? "json-to-yaml" : "yaml-to-json";
}

export default function YamlJsonConverterTool() {
  const titleId = useId();
  const inputId = useId();
  const outputId = useId();
  const feedbackId = useId();
  const inputHelpId = useId();
  const directionHelpId = useId();

  const [direction, setDirection] = useState<YamlJsonDirection>("yaml-to-json");
  const [jsonIndent, setJsonIndent] = useState<JsonOutputIndent>(2);
  const [input, setInput] = useState("");
  const [output, setOutput] = useState("");
  const [feedback, setFeedback] = useState<Feedback>(idleFeedback);

  const inputBytes = useMemo(() => getUtf8ByteLength(input), [input]);
  const outputBytes = useMemo(() => getUtf8ByteLength(output), [output]);
  const isOverLimit = inputBytes > MAX_YAML_JSON_INPUT_BYTES;
  const hasInputError =
    isOverLimit || (feedback.kind === "error" && feedback.inputRelated);
  const canTransform = input.trim().length > 0 && !isOverLimit;
  const canSwap = output.length > 0 && outputBytes <= MAX_YAML_JSON_INPUT_BYTES;
  const inputFormat = direction === "yaml-to-json" ? "YAML" : "JSON";
  const outputFormat = direction === "yaml-to-json" ? "JSON" : "YAML";

  function updateInput(nextInput: string) {
    const nextBytes = getUtf8ByteLength(nextInput);
    setInput(nextInput);
    setOutput("");

    if (nextBytes > MAX_YAML_JSON_INPUT_BYTES) {
      setFeedback({
        kind: "error",
        message: `输入为 ${displayBytes(nextBytes)}，已超过 2 MiB 上限。`,
        inputRelated: true,
      });
      return;
    }

    setFeedback(idleFeedback);
  }

  function selectDirection(nextDirection: YamlJsonDirection) {
    setDirection(nextDirection);
    setOutput("");
    setFeedback({
      kind: "idle",
      message:
        nextDirection === "yaml-to-json"
          ? "YAML 模式仅解析一个 Core Schema 文档，自定义标签不会执行。"
          : "JSON 模式接受对象、数组和其他合法 JSON 值。",
    });
  }

  function runTransform() {
    if (!input.trim()) {
      setFeedback({
        kind: "error",
        message: `请先输入需要转换的 ${inputFormat}。`,
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
    const result = transformYamlJson(input, direction, { jsonIndent });
    const duration = displayDuration(performance.now() - startedAt);

    if (!result.ok) {
      setOutput("");
      setFeedback({
        kind: "error",
        message: `${inputFormat} 转换失败：第 ${result.error.line} 行，第 ${result.error.column} 列。`,
        issue: result.error,
        inputRelated: true,
      });
      return;
    }

    setOutput(result.value);
    setFeedback({
      kind: "success",
      message: `${inputFormat} 已转换为 ${outputFormat}，用时 ${duration}。`,
    });
  }

  function swapValues() {
    if (!canSwap) return;

    const previousInput = input;
    setInput(output);
    setOutput(previousInput);
    setDirection(oppositeDirection(direction));
    setFeedback({
      kind: "idle",
      message: "输入与输出已交换，转换方向也已同步切换。",
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

    const extension = outputFormat.toLowerCase();
    const mimeType =
      outputFormat === "JSON"
        ? "application/json;charset=utf-8"
        : "application/yaml;charset=utf-8";
    const blobUrl = URL.createObjectURL(new Blob([output], { type: mimeType }));
    const link = document.createElement("a");
    link.href = blobUrl;
    link.download = `converted.${extension}`;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(blobUrl), 0);

    setFeedback({ kind: "success", message: `已下载 ${link.download}。` });
  }

  function loadSample() {
    setInput(SAMPLES[direction]);
    setOutput("");
    setFeedback({
      kind: "idle",
      message: `${inputFormat} 示例已载入，可以开始转换。`,
    });
  }

  function clearWorkspace() {
    setInput("");
    setOutput("");
    setFeedback({ kind: "idle", message: "输入和结果已清空。" });
  }

  return (
    <ToolWorkspace
      toolId="yaml-json-converter"
      titleId={titleId}
      className="yaml-json-tool"
    >
      <ToolWorkspaceHeader className="yaml-json-tool__heading">
        <div>
          <p className="eyebrow">交互区域</p>
          <h2 id={titleId}>YAML ↔ JSON 双向转换</h2>
        </div>
        <span className="limit-label">输入上限 2 MiB</span>
      </ToolWorkspaceHeader>

      <div className="yaml-json-tool__toolbar">
        <fieldset
          className="yaml-json-tool__direction"
          aria-describedby={directionHelpId}
        >
          <legend>转换方向</legend>
          <div className="yaml-json-tool__segments">
            {(
              [
                ["yaml-to-json", "YAML → JSON"],
                ["json-to-yaml", "JSON → YAML"],
              ] as const
            ).map(([value, label]) => (
              <label key={value}>
                <input
                  type="radio"
                  name="yaml-json-direction"
                  value={value}
                  checked={direction === value}
                  onChange={() => selectDirection(value)}
                />
                <span>{label}</span>
              </label>
            ))}
          </div>
        </fieldset>

        {direction === "yaml-to-json" ? (
          <fieldset className="yaml-json-tool__indent">
            <legend>JSON 缩进</legend>
            <div className="yaml-json-tool__segments">
              {(
                [
                  [2, "2 空格"],
                  [4, "4 空格"],
                ] as const
              ).map(([value, label]) => (
                <label key={value}>
                  <input
                    type="radio"
                    name="yaml-json-indentation"
                    value={value}
                    checked={jsonIndent === value}
                    onChange={() => {
                      setJsonIndent(value);
                      setOutput("");
                      setFeedback({
                        kind: "idle",
                        message: `JSON 输出将使用 ${value} 个空格缩进。`,
                      });
                    }}
                  />
                  <span>{label}</span>
                </label>
              ))}
            </div>
          </fieldset>
        ) : null}
      </div>

      <p id={directionHelpId} className="yaml-json-tool__mode-help">
        {direction === "yaml-to-json"
          ? "仅支持单个 YAML 1.2 Core Schema 文档；关闭自定义标签与合并键，并限制别名展开。"
          : "输出单个 YAML 1.2 文档；JSON 中的对象、数组、中文、布尔值和 null 均会保留。"}
      </p>

      <div className="yaml-json-tool__editors">
        <ToolWorkspaceRegion region="input" className="yaml-json-tool__editor">
          <div className="yaml-json-tool__editor-head">
            <label htmlFor={inputId}>{inputFormat} 输入</label>
            <span
              className={
                isOverLimit
                  ? "yaml-json-tool__count is-over"
                  : "yaml-json-tool__count"
              }
            >
              {displayBytes(inputBytes)} / 2 MiB
            </span>
          </div>
          <textarea
            id={inputId}
            className="yaml-json-tool__textarea"
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
              direction === "yaml-to-json"
                ? "粘贴 YAML，例如 name: Online Tools Hub"
                : '粘贴 JSON，例如 {"name":"Online Tools Hub"}'
            }
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            wrap="off"
            data-privacy-canary-input
          />
          <p id={inputHelpId} className="yaml-json-tool__editor-help">
            <kbd>Ctrl</kbd>/<kbd>⌘</kbd> + <kbd>Enter</kbd>
            快速转换；输入不会发送网络请求或写入持久化存储。
          </p>
        </ToolWorkspaceRegion>

        <ToolWorkspaceRegion region="output" className="yaml-json-tool__editor">
          <div className="yaml-json-tool__editor-head">
            <label htmlFor={outputId}>{outputFormat} 输出</label>
            <span className="yaml-json-tool__count">
              {output ? displayBytes(outputBytes) : "等待转换"}
            </span>
          </div>
          <textarea
            id={outputId}
            className="yaml-json-tool__textarea yaml-json-tool__textarea--output"
            value={output}
            placeholder={`${outputFormat} 结果会以纯文本显示在这里`}
            readOnly
            spellCheck={false}
            wrap="off"
          />
          <p className="yaml-json-tool__editor-help">
            输出仅以纯文本呈现，不会执行标签、函数或其中的任何内容。
          </p>
        </ToolWorkspaceRegion>
      </div>

      <div
        id={feedbackId}
        className={`yaml-json-tool__feedback yaml-json-tool__feedback--${feedback.kind}`}
        role={feedback.kind === "error" ? "alert" : "status"}
        aria-live={feedback.kind === "error" ? "assertive" : "polite"}
        aria-atomic="true"
      >
        <span className="yaml-json-tool__feedback-mark" aria-hidden="true">
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

      <ToolWorkspaceActions className="yaml-json-tool__actions">
        <div className="yaml-json-tool__actions-primary">
          <ToolWorkspaceAction
            action="execute"
            className="button button--primary"
            type="button"
            onClick={runTransform}
            disabled={!canTransform}
            data-privacy-canary-action
          >
            转换为 {outputFormat}
          </ToolWorkspaceAction>
          <ToolWorkspaceAction
            action="swap"
            className="button button--secondary"
            type="button"
            onClick={swapValues}
            disabled={!canSwap}
            title={
              outputBytes > MAX_YAML_JSON_INPUT_BYTES
                ? "结果超过输入上限，无法交换"
                : undefined
            }
          >
            交换输入输出
          </ToolWorkspaceAction>
        </div>

        <div className="yaml-json-tool__actions-secondary">
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
            action="download"
            className="button button--secondary"
            type="button"
            onClick={downloadOutput}
            disabled={!output}
          >
            下载 .{outputFormat.toLowerCase()}
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
    </ToolWorkspace>
  );
}

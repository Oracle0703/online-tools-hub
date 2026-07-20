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
  MAX_CSV_JSON_INPUT_BYTES,
  transformCsvJson,
  type CsvDelimiter,
  type CsvDelimiterOption,
  type CsvJsonDirection,
  type CsvJsonErrorDetails,
  type CsvJsonIndent,
} from "../../tools/csv-json-converter";

import "./CsvJsonConverterTool.css";

const SAMPLES: Record<CsvJsonDirection, string> = {
  "csv-to-json": `id,name,city,note
001,小明,上海,"保留前导零"
002,小红,深圳,"包含,逗号"
003,小李,杭州,"第一行
第二行"`,
  "json-to-csv": `[
  {
    "id": "001",
    "name": "小明",
    "city": "上海",
    "active": true
  },
  {
    "id": "002",
    "name": "小红",
    "city": "深圳",
    "active": false
  }
]`,
};

type Feedback =
  | { kind: "idle"; message: string }
  | { kind: "success"; message: string }
  | {
      kind: "error";
      message: string;
      issue?: CsvJsonErrorDetails;
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

function oppositeDirection(direction: CsvJsonDirection): CsvJsonDirection {
  return direction === "csv-to-json" ? "json-to-csv" : "csv-to-json";
}

function delimiterLabel(delimiter: CsvDelimiter): string {
  if (delimiter === ",") return "逗号";
  if (delimiter === ";") return "分号";
  return "制表符";
}

export default function CsvJsonConverterTool() {
  const titleId = useId();
  const inputId = useId();
  const outputId = useId();
  const feedbackId = useId();
  const inputHelpId = useId();
  const directionHelpId = useId();
  const delimiterId = useId();

  const [direction, setDirection] = useState<CsvJsonDirection>("csv-to-json");
  const [delimiter, setDelimiter] = useState<CsvDelimiterOption>("auto");
  const [jsonIndent, setJsonIndent] = useState<CsvJsonIndent>(2);
  const [input, setInput] = useState("");
  const [output, setOutput] = useState("");
  const [lastDelimiter, setLastDelimiter] = useState<CsvDelimiter | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(idleFeedback);

  const inputBytes = useMemo(() => getUtf8ByteLength(input), [input]);
  const outputBytes = useMemo(() => getUtf8ByteLength(output), [output]);
  const isOverLimit = inputBytes > MAX_CSV_JSON_INPUT_BYTES;
  const hasInputError =
    isOverLimit || (feedback.kind === "error" && feedback.inputRelated);
  const canTransform = input.trim().length > 0 && !isOverLimit;
  const canSwap = output.length > 0 && outputBytes <= MAX_CSV_JSON_INPUT_BYTES;
  const inputFormat = direction === "csv-to-json" ? "CSV" : "JSON";
  const outputFormat = direction === "csv-to-json" ? "JSON" : "CSV";

  function resetResult(message: string) {
    setOutput("");
    setLastDelimiter(null);
    setFeedback({ kind: "idle", message });
  }

  function updateInput(nextInput: string) {
    const nextBytes = getUtf8ByteLength(nextInput);
    setInput(nextInput);
    setOutput("");
    setLastDelimiter(null);

    if (nextBytes > MAX_CSV_JSON_INPUT_BYTES) {
      setFeedback({
        kind: "error",
        message: `输入为 ${displayBytes(nextBytes)}，已超过 2 MiB 上限。`,
        inputRelated: true,
      });
      return;
    }

    setFeedback(idleFeedback);
  }

  function selectDirection(nextDirection: CsvJsonDirection) {
    setDirection(nextDirection);
    if (nextDirection === "json-to-csv" && delimiter === "auto") {
      setDelimiter(",");
    }
    resetResult(
      nextDirection === "csv-to-json"
        ? "CSV 的第一行将作为唯一表头，所有单元格按字符串输出。"
        : "JSON 顶层需为普通对象数组，嵌套对象和数组不会被静默展开。",
    );
  }

  function selectDelimiter(nextDelimiter: CsvDelimiterOption) {
    setDelimiter(nextDelimiter);
    resetResult(
      nextDelimiter === "auto"
        ? "将保守检测逗号、分号或制表符；存在歧义时会要求手动选择。"
        : `${direction === "csv-to-json" ? "输入" : "输出"}将使用${delimiterLabel(nextDelimiter)}分隔。`,
    );
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
    const result = transformCsvJson(input, direction, {
      delimiter,
      jsonIndent,
    });
    const duration = displayDuration(performance.now() - startedAt);

    if (!result.ok) {
      setOutput("");
      setLastDelimiter(null);
      setFeedback({
        kind: "error",
        message: `${inputFormat} 转换失败：第 ${result.error.line} 行，第 ${result.error.column} 列。`,
        issue: result.error,
        inputRelated: true,
      });
      return;
    }

    setOutput(result.value);
    setLastDelimiter(result.delimiter);
    setFeedback({
      kind: "success",
      message: `${inputFormat} 已转换为 ${outputFormat}：${result.rows.toLocaleString("zh-CN")} 行 × ${result.columns.toLocaleString("zh-CN")} 列，使用${delimiterLabel(result.delimiter)}，用时 ${duration}。`,
    });
  }

  function swapValues() {
    if (!canSwap) return;

    const previousInput = input;
    const nextDirection = oppositeDirection(direction);
    setInput(output);
    setOutput(previousInput);
    setDirection(nextDirection);
    setDelimiter(lastDelimiter ?? ",");
    setLastDelimiter(lastDelimiter);
    setFeedback({
      kind: "idle",
      message: "输入与输出已交换，转换方向和 CSV 分隔符也已同步切换。",
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
        : "text/csv;charset=utf-8";
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
    setLastDelimiter(null);
    if (direction === "csv-to-json") setDelimiter("auto");
    setFeedback({
      kind: "idle",
      message: `${inputFormat} 示例已载入，可以开始转换。`,
    });
  }

  function clearWorkspace() {
    setInput("");
    setOutput("");
    setLastDelimiter(null);
    setFeedback({ kind: "idle", message: "输入和结果已清空。" });
  }

  return (
    <ToolWorkspace
      toolId="csv-json-converter"
      titleId={titleId}
      className="csv-json-tool"
    >
      <ToolWorkspaceHeader className="csv-json-tool__heading">
        <div>
          <p className="eyebrow">交互区域</p>
          <h2 id={titleId}>CSV ↔ JSON 双向转换</h2>
        </div>
        <span className="limit-label">输入上限 2 MiB</span>
      </ToolWorkspaceHeader>

      <div className="csv-json-tool__toolbar">
        <fieldset
          className="csv-json-tool__direction"
          aria-describedby={directionHelpId}
        >
          <legend>转换方向</legend>
          <div className="csv-json-tool__segments">
            {(
              [
                ["csv-to-json", "CSV → JSON"],
                ["json-to-csv", "JSON → CSV"],
              ] as const
            ).map(([value, label]) => (
              <label key={value}>
                <input
                  type="radio"
                  name="csv-json-direction"
                  value={value}
                  checked={direction === value}
                  onChange={() => selectDirection(value)}
                />
                <span>{label}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <div className="csv-json-tool__delimiter">
          <label htmlFor={delimiterId}>CSV 分隔符</label>
          <select
            id={delimiterId}
            value={delimiter}
            onChange={(event) =>
              selectDelimiter(event.currentTarget.value as CsvDelimiterOption)
            }
          >
            {direction === "csv-to-json" ? (
              <option value="auto">安全自动识别</option>
            ) : null}
            <option value=",">逗号 (,)</option>
            <option value=";">分号 (;)</option>
            <option value={"\t"}>制表符 (Tab)</option>
          </select>
        </div>

        {direction === "csv-to-json" ? (
          <fieldset className="csv-json-tool__indent">
            <legend>JSON 缩进</legend>
            <div className="csv-json-tool__segments">
              {(
                [
                  [2, "2 空格"],
                  [4, "4 空格"],
                ] as const
              ).map(([value, label]) => (
                <label key={value}>
                  <input
                    type="radio"
                    name="csv-json-indentation"
                    value={value}
                    checked={jsonIndent === value}
                    onChange={() => {
                      setJsonIndent(value);
                      resetResult(`JSON 输出将使用 ${value} 个空格缩进。`);
                    }}
                  />
                  <span>{label}</span>
                </label>
              ))}
            </div>
          </fieldset>
        ) : null}
      </div>

      <p id={directionHelpId} className="csv-json-tool__mode-help">
        {direction === "csv-to-json"
          ? "支持 BOM、CRLF、双引号转义和引号内换行；表头必须非空且唯一，所有单元格始终保留为字符串。"
          : "接受普通对象数组；字符串、有限数字、布尔值和 null 可写入单元格，嵌套结构与不安全数字会明确报错。"}
      </p>

      <div className="csv-json-tool__editors">
        <ToolWorkspaceRegion region="input" className="csv-json-tool__editor">
          <div className="csv-json-tool__editor-head">
            <label htmlFor={inputId}>{inputFormat} 输入</label>
            <span
              className={
                isOverLimit
                  ? "csv-json-tool__count is-over"
                  : "csv-json-tool__count"
              }
            >
              {displayBytes(inputBytes)} / 2 MiB
            </span>
          </div>
          <textarea
            id={inputId}
            className="csv-json-tool__textarea"
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
              direction === "csv-to-json"
                ? "粘贴 CSV，例如 name,city"
                : '粘贴 JSON 对象数组，例如 [{"name":"小明"}]'
            }
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            wrap="off"
            data-privacy-canary-input
          />
          <p id={inputHelpId} className="csv-json-tool__editor-help">
            <kbd>Ctrl</kbd>/<kbd>⌘</kbd> + <kbd>Enter</kbd>
            快速转换；输入不会发送网络请求或写入持久化存储。
          </p>
        </ToolWorkspaceRegion>

        <ToolWorkspaceRegion region="output" className="csv-json-tool__editor">
          <div className="csv-json-tool__editor-head">
            <label htmlFor={outputId}>{outputFormat} 输出</label>
            <span className="csv-json-tool__count">
              {output ? displayBytes(outputBytes) : "等待转换"}
            </span>
          </div>
          <textarea
            id={outputId}
            className="csv-json-tool__textarea csv-json-tool__textarea--output"
            value={output}
            placeholder={`${outputFormat} 结果会以纯文本显示在这里`}
            readOnly
            spellCheck={false}
            wrap="off"
          />
          <p className="csv-json-tool__editor-help">
            页面内只显示纯文本，不会执行公式或脚本。下载 CSV
            后用表格软件打开前，请检查以 =、+、-、@
            开头的单元格，它们可能被解释为公式。
          </p>
        </ToolWorkspaceRegion>
      </div>

      <div
        id={feedbackId}
        className={`csv-json-tool__feedback csv-json-tool__feedback--${feedback.kind}`}
        role={feedback.kind === "error" ? "alert" : "status"}
        aria-live={feedback.kind === "error" ? "assertive" : "polite"}
        aria-atomic="true"
      >
        <span className="csv-json-tool__feedback-mark" aria-hidden="true">
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

      <ToolWorkspaceActions className="csv-json-tool__actions">
        <div className="csv-json-tool__actions-primary">
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
              outputBytes > MAX_CSV_JSON_INPUT_BYTES
                ? "结果超过输入上限，无法交换"
                : undefined
            }
          >
            交换输入输出
          </ToolWorkspaceAction>
        </div>

        <div className="csv-json-tool__actions-secondary">
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

      {direction === "csv-to-json" &&
      output &&
      outputBytes <= MAX_CSV_JSON_INPUT_BYTES ? (
        <ToolRelay
          value={output}
          sourceLabel="JSON 结果"
          targetSlug="json-formatter"
          targetLabel="JSON 格式化"
        />
      ) : null}
    </ToolWorkspace>
  );
}

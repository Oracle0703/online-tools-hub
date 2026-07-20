import { useId, useMemo, useRef, useState } from "react";

import {
  ToolWorkspace,
  ToolWorkspaceAction,
  ToolWorkspaceActions,
  ToolWorkspaceHeader,
  ToolWorkspaceRegion,
} from "../ToolWorkspace";
import {
  buildQueryString,
  exportQueryParametersJson,
  MAX_QUERY_INPUT_BYTES,
  MAX_QUERY_PARAMETERS,
  parseQueryInput,
  rebuildQueryInput,
  sortQueryParameters,
  type ParsedQueryDocument,
  type QueryEncoding,
  type QueryErrorDetails,
  type QueryParameter,
} from "../../tools/query-params";

import "./QueryParamsTool.css";

const SAMPLE =
  "https://example.com/search?q=%E4%B8%AD%E6%96%87+tools&tag=web&tag=local&empty=&preview#results";

type OutputMode = "rebuilt" | "query";

interface EditorParameter extends QueryParameter {
  id: number;
}

type Feedback =
  | { kind: "idle"; message: string }
  | { kind: "success"; message: string }
  | {
      kind: "error";
      message: string;
      issue?: QueryErrorDetails;
      inputRelated?: boolean;
    };

const idleFeedback: Feedback = {
  kind: "idle",
  message: "地址和参数只在当前浏览器标签页内处理，不会请求或打开输入地址。",
};
const parameterEditFeedback: Feedback = {
  kind: "idle",
  message: "参数已修改，重建结果已在本地同步更新。",
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

function downloadText(value: string, filename: string, type: string): void {
  const blobUrl = URL.createObjectURL(new Blob([value], { type }));
  const link = document.createElement("a");
  link.href = blobUrl;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(blobUrl), 0);
}

function sourceKindLabel(document: ParsedQueryDocument): string {
  switch (document.sourceKind) {
    case "url":
      return "URL 地址";
    case "query":
      return "? 查询串";
    case "bare":
      return "裸查询串";
  }
}

export default function QueryParamsTool() {
  const titleId = useId();
  const inputId = useId();
  const inputHelpId = useId();
  const feedbackId = useId();
  const encodingHelpId = useId();
  const outputId = useId();
  const outputErrorId = useId();
  const rowIdPrefix = useId();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const addParameterButtonRef = useRef<HTMLButtonElement>(null);
  const nextParameterId = useRef(1);

  const [input, setInput] = useState("");
  const [encoding, setEncoding] = useState<QueryEncoding>("form");
  const [document, setDocument] = useState<ParsedQueryDocument | null>(null);
  const [parameters, setParameters] = useState<EditorParameter[]>([]);
  const [outputMode, setOutputMode] = useState<OutputMode>("rebuilt");
  const [feedback, setFeedback] = useState<Feedback>(idleFeedback);

  const inputBytes = useMemo(() => getUtf8ByteLength(input), [input]);
  const isOverLimit = inputBytes > MAX_QUERY_INPUT_BYTES;
  const canParse = input.length > 0 && !isOverLimit;
  const hasInputError =
    isOverLimit || (feedback.kind === "error" && feedback.inputRelated);

  const queryResult = useMemo(
    () => (document ? buildQueryString(parameters, { encoding }) : null),
    [document, encoding, parameters],
  );
  const rebuiltResult = useMemo(
    () =>
      document ? rebuildQueryInput(document, parameters, { encoding }) : null,
    [document, encoding, parameters],
  );
  const currentResult = outputMode === "rebuilt" ? rebuiltResult : queryResult;
  const buildError =
    currentResult?.ok === false ? currentResult.error : undefined;
  const output =
    currentResult?.ok === true
      ? outputMode === "query"
        ? `?${currentResult.value}`
        : currentResult.value
      : "";
  const outputBytes = useMemo(() => getUtf8ByteLength(output), [output]);

  const duplicateCount = useMemo(() => {
    const counts = new Map<string, number>();
    for (const parameter of parameters) {
      counts.set(parameter.key, (counts.get(parameter.key) ?? 0) + 1);
    }
    let duplicates = 0;
    for (const count of counts.values()) duplicates += Math.max(0, count - 1);
    return duplicates;
  }, [parameters]);
  const noEqualsCount = useMemo(
    () => parameters.filter((parameter) => !parameter.hasEquals).length,
    [parameters],
  );

  function createEditorParameters(
    nextParameters: readonly QueryParameter[],
  ): EditorParameter[] {
    return nextParameters.map((parameter) => ({
      ...parameter,
      id: nextParameterId.current++,
    }));
  }

  function updateInput(nextInput: string) {
    const nextBytes = getUtf8ByteLength(nextInput);
    setInput(nextInput);
    setDocument(null);
    setParameters([]);

    if (nextBytes > MAX_QUERY_INPUT_BYTES) {
      setFeedback({
        kind: "error",
        message: `输入为 ${displayBytes(nextBytes)}，已超过 2 MiB 上限。`,
        inputRelated: true,
      });
      return;
    }

    setFeedback(idleFeedback);
  }

  function runParse() {
    if (!input.length) {
      setFeedback({
        kind: "error",
        message: "请先输入完整 URL、? 查询串或裸查询串。",
        inputRelated: true,
      });
      inputRef.current?.focus();
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
    const result = parseQueryInput(input, { encoding });
    if (!result.ok) {
      setDocument(null);
      setParameters([]);
      setFeedback({
        kind: "error",
        message: `解析失败：第 ${result.error.line} 行，第 ${result.error.column} 列${
          result.error.parameterIndex
            ? `（参数 ${result.error.parameterIndex}）`
            : ""
        }。`,
        issue: result.error,
        inputRelated: true,
      });
      window.requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.setSelectionRange(
          result.error.offset,
          Math.min(result.error.offset + 1, input.length),
        );
      });
      return;
    }

    setDocument(result.value);
    setParameters(createEditorParameters(result.value.parameters));
    setOutputMode("rebuilt");
    setFeedback({
      kind: "success",
      message: `已解析 ${result.value.parameters.length} 项参数（${sourceKindLabel(
        result.value,
      )}），用时 ${displayDuration(performance.now() - startedAt)}。`,
    });
  }

  function selectEncoding(nextEncoding: QueryEncoding) {
    setEncoding(nextEncoding);
    setFeedback({
      kind: "idle",
      message:
        nextEncoding === "form"
          ? "已使用表单规则：原文中的 + 解析为空格，字面 + 输出为 %2B。重新解析可按此规则解释原文。"
          : "已使用 RFC 百分号规则：空格输出为 %20，原文中的 + 保持字面含义。重新解析可按此规则解释原文。",
    });
  }

  function updateParameter(
    id: number,
    patch: Partial<Pick<QueryParameter, "key" | "value" | "hasEquals">>,
  ) {
    setParameters((current) =>
      current.map((parameter) =>
        parameter.id === id ? { ...parameter, ...patch } : parameter,
      ),
    );
    setFeedback((current) =>
      current.kind === parameterEditFeedback.kind &&
      current.message === parameterEditFeedback.message
        ? current
        : parameterEditFeedback,
    );
  }

  function addParameter() {
    if (parameters.length >= MAX_QUERY_PARAMETERS) {
      setFeedback({
        kind: "error",
        message: `最多编辑 ${MAX_QUERY_PARAMETERS.toLocaleString("zh-CN")} 项参数。`,
      });
      return;
    }

    if (!document) {
      const blankDocument: ParsedQueryDocument = {
        sourceKind: "query",
        base: "",
        fragment: "",
        hadQueryMarker: true,
        parameters: [],
      };
      setDocument(blankDocument);
      setInput("?");
    }

    const id = nextParameterId.current++;
    setParameters((current) => [
      ...current,
      { id, key: "", value: "", hasEquals: true },
    ]);
    setFeedback({
      kind: "idle",
      message: "已新增一个空参数；空参数名和空值都会按原义保留。",
    });
    window.requestAnimationFrame(() => {
      globalThis.document.getElementById(`${rowIdPrefix}-${id}-key`)?.focus();
    });
  }

  function removeParameter(id: number) {
    const currentIndex = parameters.findIndex(
      (parameter) => parameter.id === id,
    );
    const focusTarget =
      parameters[currentIndex + 1] ?? parameters[currentIndex - 1];
    setParameters((current) =>
      current.filter((parameter) => parameter.id !== id),
    );
    setFeedback({
      kind: "idle",
      message: "参数已删除，其余参数顺序保持不变。",
    });
    window.requestAnimationFrame(() => {
      if (focusTarget) {
        globalThis.document
          .getElementById(`${rowIdPrefix}-${focusTarget.id}-key`)
          ?.focus();
      } else {
        addParameterButtonRef.current?.focus();
      }
    });
  }

  function sortParameters() {
    setParameters((current) => sortQueryParameters(current));
    setFeedback({
      kind: "success",
      message: "已按解码后的参数名稳定排序；重复键之间的原顺序保持不变。",
    });
  }

  function reportBuildError() {
    if (!currentResult || currentResult.ok) return false;
    setFeedback({
      kind: "error",
      message: `无法重建：参数 ${currentResult.error.parameterIndex ?? ""} 包含无效字符。`,
      issue: currentResult.error,
    });
    return true;
  }

  async function copyOutput() {
    if (reportBuildError() || !output) return;
    try {
      await copyToClipboard(output);
      setFeedback({ kind: "success", message: "重建结果已复制到剪贴板。" });
    } catch {
      setFeedback({
        kind: "error",
        message: "复制失败，请选中结果后手动复制。",
      });
    }
  }

  function downloadOutput() {
    if (reportBuildError() || !output) return;
    const filename =
      outputMode === "rebuilt" ? "rebuilt-query.txt" : "query-string.txt";
    downloadText(output, filename, "text/plain;charset=utf-8");
    setFeedback({ kind: "success", message: `已下载 ${filename}。` });
  }

  function exportJson() {
    if (!document) return;
    const json = exportQueryParametersJson(document, parameters, encoding);
    downloadText(
      json,
      "query-parameters.json",
      "application/json;charset=utf-8",
    );
    setFeedback({
      kind: "success",
      message: "已导出 query-parameters.json，顺序及无等号语义均已保留。",
    });
  }

  function loadSample() {
    setInput(SAMPLE);
    setDocument(null);
    setParameters([]);
    setEncoding("form");
    setOutputMode("rebuilt");
    setFeedback({
      kind: "idle",
      message: "示例已载入；其中包含重复键、空值和无等号参数。",
    });
  }

  function clearWorkspace() {
    setInput("");
    setDocument(null);
    setParameters([]);
    setOutputMode("rebuilt");
    setFeedback({ kind: "idle", message: "输入、参数和结果已清空。" });
  }

  return (
    <ToolWorkspace
      toolId="query-params"
      titleId={titleId}
      className="query-params-tool"
    >
      <ToolWorkspaceHeader className="query-params-tool__heading">
        <div>
          <p className="eyebrow">交互区域</p>
          <h2 id={titleId}>URL 查询参数解析与构建</h2>
        </div>
        <span className="limit-label">输入上限 2 MiB</span>
      </ToolWorkspaceHeader>

      <div className="query-params-tool__toolbar">
        <fieldset
          className="query-params-tool__encoding"
          aria-describedby={encodingHelpId}
        >
          <legend>空格与加号规则</legend>
          <div className="query-params-tool__segments">
            {(
              [
                ["form", "表单 + 空格"],
                ["rfc3986", "RFC 百分号"],
              ] as const
            ).map(([value, label]) => (
              <label key={value}>
                <input
                  type="radio"
                  name="query-params-encoding"
                  value={value}
                  checked={encoding === value}
                  onChange={() => selectEncoding(value)}
                />
                <span>{label}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <p className="query-params-tool__privacy">纯本地 · 不访问输入地址</p>
      </div>
      <p id={encodingHelpId} className="query-params-tool__mode-help">
        {encoding === "form"
          ? "application/x-www-form-urlencoded 规则：+ 表示空格；字面加号必须写成 %2B。"
          : "RFC 3986 百分号规则：空格写成 %20；+ 是普通字符并保持为加号。"}
      </p>

      <ToolWorkspaceRegion region="input" className="query-params-tool__source">
        <div className="query-params-tool__editor-head">
          <label htmlFor={inputId}>URL 或查询串输入</label>
          <span
            className={
              isOverLimit
                ? "query-params-tool__count is-over"
                : "query-params-tool__count"
            }
          >
            {displayBytes(inputBytes)} / 2 MiB
          </span>
        </div>
        <textarea
          ref={inputRef}
          id={inputId}
          className="query-params-tool__source-input"
          value={input}
          onChange={(event) => updateInput(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (
              (event.ctrlKey || event.metaKey) &&
              event.key === "Enter" &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              runParse();
            }
          }}
          aria-describedby={`${inputHelpId} ${feedbackId}`}
          aria-errormessage={hasInputError ? feedbackId : undefined}
          aria-invalid={hasInputError || undefined}
          placeholder="https://example.com/search?q=hello+world&tag=web，或 ?q=hello，或 q=hello"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          wrap="off"
          data-privacy-canary-input
        />
        <p id={inputHelpId} className="query-params-tool__source-help">
          支持完整 URL、以 ? 开头或裸查询串。按 <kbd>Ctrl</kbd>/<kbd>⌘</kbd> +
          <kbd>Enter</kbd> 解析；不会自动排序或合并重复键。
        </p>
      </ToolWorkspaceRegion>

      <div className="query-params-tool__parse-row">
        <ToolWorkspaceAction
          action="execute"
          className="button button--primary"
          type="button"
          onClick={runParse}
          disabled={!canParse}
          data-privacy-canary-action
        >
          解析查询参数
        </ToolWorkspaceAction>
        <span>最多 {MAX_QUERY_PARAMETERS.toLocaleString("zh-CN")} 项参数</span>
      </div>

      {document ? (
        <section
          className="query-params-tool__structure"
          aria-labelledby={`${titleId}-structure`}
        >
          <div className="query-params-tool__section-head">
            <div>
              <p className="eyebrow">结构化编辑</p>
              <h3 id={`${titleId}-structure`}>参数列表</h3>
            </div>
            <div className="query-params-tool__summary" aria-label="解析摘要">
              <span>{parameters.length} 项</span>
              <span>{duplicateCount} 个重复键</span>
              <span>{noEqualsCount} 项无等号</span>
            </div>
          </div>

          <div className="query-params-tool__list">
            {parameters.length > 0 ? (
              parameters.map((parameter, index) => {
                const keyId = `${rowIdPrefix}-${parameter.id}-key`;
                const valueId = `${rowIdPrefix}-${parameter.id}-value`;
                const shapeId = `${rowIdPrefix}-${parameter.id}-shape`;
                return (
                  <fieldset
                    className="query-params-tool__parameter"
                    key={parameter.id}
                  >
                    <legend>参数 {index + 1}</legend>
                    <label>
                      <span>参数名</span>
                      <input
                        id={keyId}
                        value={parameter.key}
                        onChange={(event) =>
                          updateParameter(parameter.id, {
                            key: event.currentTarget.value,
                          })
                        }
                        placeholder="允许空参数名"
                        spellCheck={false}
                        autoCapitalize="off"
                        autoCorrect="off"
                      />
                    </label>
                    <label>
                      <span>形式</span>
                      <select
                        id={shapeId}
                        value={parameter.hasEquals ? "equals" : "bare"}
                        onChange={(event) =>
                          updateParameter(parameter.id, {
                            hasEquals: event.currentTarget.value === "equals",
                          })
                        }
                        aria-label={`参数 ${index + 1} 的等号形式`}
                      >
                        <option value="equals">键=值</option>
                        <option value="bare">无等号</option>
                      </select>
                    </label>
                    <label>
                      <span>参数值</span>
                      <input
                        id={valueId}
                        value={parameter.value}
                        onChange={(event) =>
                          updateParameter(parameter.id, {
                            value: event.currentTarget.value,
                          })
                        }
                        placeholder={
                          parameter.hasEquals
                            ? "允许空值"
                            : "无等号项不输出参数值"
                        }
                        disabled={!parameter.hasEquals}
                        spellCheck={false}
                        autoCapitalize="off"
                        autoCorrect="off"
                      />
                    </label>
                    <button
                      className="button button--quiet query-params-tool__remove"
                      type="button"
                      onClick={() => removeParameter(parameter.id)}
                      aria-label={`删除参数 ${index + 1}`}
                    >
                      删除
                    </button>
                  </fieldset>
                );
              })
            ) : (
              <p className="query-params-tool__empty">
                当前没有参数。可以新增一项，或保留为空查询串。
              </p>
            )}
          </div>

          <div className="query-params-tool__structure-actions">
            <button
              ref={addParameterButtonRef}
              className="button button--secondary"
              type="button"
              onClick={addParameter}
              disabled={parameters.length >= MAX_QUERY_PARAMETERS}
            >
              新增参数
            </button>
            <button
              className="button button--quiet"
              type="button"
              onClick={sortParameters}
              disabled={parameters.length < 2}
              title="只有点击此按钮才会改变参数顺序"
            >
              按参数名排序
            </button>
          </div>
        </section>
      ) : (
        <div className="query-params-tool__empty-state">
          <p>解析后可逐项编辑、删除、显式排序并重新构建。</p>
          <button
            ref={addParameterButtonRef}
            className="button button--secondary"
            type="button"
            onClick={addParameter}
          >
            从空查询串开始
          </button>
        </div>
      )}

      <ToolWorkspaceRegion
        region="output"
        className="query-params-tool__output"
      >
        <div className="query-params-tool__output-head">
          <div>
            <p className="eyebrow">重建结果</p>
            <label htmlFor={outputId}>
              {outputMode === "rebuilt" ? "原始形式" : "仅 ? 查询串"}
            </label>
          </div>
          <fieldset>
            <legend className="sr-only">输出形式</legend>
            <div className="query-params-tool__segments">
              {(
                [
                  ["rebuilt", "原始形式"],
                  ["query", "仅 ?query"],
                ] as const
              ).map(([value, label]) => (
                <label key={value}>
                  <input
                    type="radio"
                    name="query-params-output"
                    value={value}
                    checked={outputMode === value}
                    onChange={() => setOutputMode(value)}
                  />
                  <span>{label}</span>
                </label>
              ))}
            </div>
          </fieldset>
        </div>
        <textarea
          id={outputId}
          className="query-params-tool__output-text"
          value={output}
          placeholder="解析或新增参数后，结果会显示在这里"
          readOnly
          spellCheck={false}
          wrap="off"
          aria-invalid={buildError ? true : undefined}
          aria-describedby={buildError ? outputErrorId : undefined}
        />
        {buildError ? (
          <p
            id={outputErrorId}
            className="query-params-tool__output-error"
            role="alert"
          >
            无法重建参数 {buildError.parameterIndex ?? ""}：{buildError.message}
          </p>
        ) : null}
        <div className="query-params-tool__output-meta">
          <span>{output ? displayBytes(outputBytes) : "等待解析"}</span>
          <span>片段 #fragment 只保留在“原始形式”中</span>
        </div>
      </ToolWorkspaceRegion>

      <div
        id={feedbackId}
        className={`query-params-tool__feedback query-params-tool__feedback--${feedback.kind}`}
        role={feedback.kind === "error" ? "alert" : "status"}
        aria-live={feedback.kind === "error" ? "assertive" : "polite"}
        aria-atomic="true"
      >
        <span className="query-params-tool__feedback-mark" aria-hidden="true">
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

      <ToolWorkspaceActions className="query-params-tool__actions">
        <div className="query-params-tool__actions-primary">
          <ToolWorkspaceAction
            action="copy"
            className="button button--primary"
            type="button"
            onClick={copyOutput}
            disabled={!document}
          >
            复制结果
          </ToolWorkspaceAction>
          <ToolWorkspaceAction
            action="download"
            className="button button--secondary"
            type="button"
            onClick={downloadOutput}
            disabled={!document}
          >
            下载 .txt
          </ToolWorkspaceAction>
          <ToolWorkspaceAction
            action="download"
            className="button button--secondary"
            type="button"
            onClick={exportJson}
            disabled={!document}
          >
            导出 JSON
          </ToolWorkspaceAction>
        </div>
        <div className="query-params-tool__actions-secondary">
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
            disabled={!input && !document}
          >
            清空
          </ToolWorkspaceAction>
        </div>
      </ToolWorkspaceActions>
    </ToolWorkspace>
  );
}

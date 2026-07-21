import { useId, useMemo, useRef, useState, type DragEvent } from "react";

import {
  ToolWorkspace,
  ToolWorkspaceAction,
  ToolWorkspaceActions,
  ToolWorkspaceHeader,
  ToolWorkspaceRegion,
} from "../ToolWorkspace";
import {
  compareHashHex,
  getUtf8ByteLength,
  hashBlob,
  hashText,
  HashToolError,
  MAX_HASH_FILE_BYTES,
  MAX_HASH_TEXT_BYTES,
  type HashAlgorithm,
} from "../../tools/hash-generator";

type InputMode = "text" | "file";

type Feedback = {
  kind: "idle" | "success" | "error";
  message: string;
};

type HashResult = {
  algorithm: HashAlgorithm;
  hex: string;
  source: string;
};

type ComparisonState =
  | { kind: "idle"; message: string }
  | { kind: "match" | "mismatch" | "error"; message: string };

const SAMPLE_TEXT = "abc";
const INITIAL_FEEDBACK: Feedback = {
  kind: "idle",
  message: "输入、文件名和文件内容只在当前标签页内处理，不会上传或持久化。",
};
const INITIAL_COMPARISON: ComparisonState = {
  kind: "idle",
  message: "计算摘要后，可粘贴一个期望值进行本地核对。",
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

function displayDuration(milliseconds: number): string {
  if (milliseconds < 1) return "<1 ms";
  if (milliseconds < 10) return `${milliseconds.toFixed(1)} ms`;
  return `${Math.round(milliseconds)} ms`;
}

export default function HashGeneratorTool() {
  const titleId = useId();
  const textInputId = useId();
  const fileInputId = useId();
  const outputId = useId();
  const expectedId = useId();
  const inputHelpId = useId();
  const expectedHelpId = useId();
  const feedbackId = useId();
  const algorithmName = useId();
  const inputModeName = useId();

  const [algorithm, setAlgorithm] = useState<HashAlgorithm>("SHA-256");
  const [inputMode, setInputMode] = useState<InputMode>("text");
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<HashResult | null>(null);
  const [expected, setExpected] = useState("");
  const [comparison, setComparison] =
    useState<ComparisonState>(INITIAL_COMPARISON);
  const [feedback, setFeedback] = useState<Feedback>(INITIAL_FEEDBACK);
  const [isHashing, setIsHashing] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const requestIdRef = useRef(0);
  const textBytes = useMemo(() => getUtf8ByteLength(text), [text]);
  const textIsOverLimit = textBytes > MAX_HASH_TEXT_BYTES;
  const canHash =
    !isHashing && (inputMode === "text" ? !textIsOverLimit : Boolean(file));
  const expectedLength = algorithm === "SHA-256" ? 64 : 128;

  function invalidateResult(message = INITIAL_FEEDBACK.message) {
    requestIdRef.current += 1;
    setResult(null);
    setComparison(INITIAL_COMPARISON);
    setFeedback({ kind: "idle", message });
    setIsHashing(false);
  }

  function changeAlgorithm(nextAlgorithm: HashAlgorithm) {
    setAlgorithm(nextAlgorithm);
    invalidateResult(`已选择 ${nextAlgorithm}；请重新计算摘要。`);
  }

  function changeInputMode(nextMode: InputMode) {
    setInputMode(nextMode);
    invalidateResult(
      nextMode === "text"
        ? "文本将按 UTF-8 编码后在本地计算摘要。"
        : "文件会先完整读入内存，再交给 Web Crypto 进行一次性摘要。",
    );
  }

  function updateText(nextText: string) {
    const nextBytes = getUtf8ByteLength(nextText);
    setText(nextText);
    invalidateResult(
      nextBytes > MAX_HASH_TEXT_BYTES
        ? `文本为 ${formatBytes(nextBytes)}，已超过 2 MiB 上限。`
        : INITIAL_FEEDBACK.message,
    );
    if (nextBytes > MAX_HASH_TEXT_BYTES) {
      setFeedback({
        kind: "error",
        message: `文本为 ${formatBytes(nextBytes)}，已超过 2 MiB 上限。`,
      });
    }
  }

  function selectFile(nextFile: File | null) {
    invalidateResult();

    if (!nextFile) {
      setFile(null);
      setFeedback({ kind: "idle", message: "尚未选择文件。" });
      return;
    }

    if (nextFile.size > MAX_HASH_FILE_BYTES) {
      setFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      setFeedback({
        kind: "error",
        message: `文件为 ${formatBytes(nextFile.size)}，已超过 20 MiB 一次性摘要上限。`,
      });
      return;
    }

    setFile(nextFile);
    setFeedback({
      kind: "idle",
      message: `已选择 ${nextFile.name}（${formatBytes(nextFile.size)}），内容尚未读取。`,
    });
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDragging(false);
    selectFile(event.dataTransfer.files.item(0));
  }

  async function generateHash() {
    if (!canHash) return;

    const requestId = ++requestIdRef.current;
    const selectedAlgorithm = algorithm;
    const selectedMode = inputMode;
    const selectedFile = file;
    const startedAt = performance.now();

    setIsHashing(true);
    setResult(null);
    setComparison(INITIAL_COMPARISON);
    setFeedback({
      kind: "idle",
      message:
        selectedMode === "file" ? "正在读取文件并计算摘要…" : "正在计算摘要…",
    });

    try {
      const hex =
        selectedMode === "text"
          ? await hashText(text, selectedAlgorithm)
          : selectedFile
            ? await hashBlob(selectedFile, selectedAlgorithm)
            : null;

      if (requestId !== requestIdRef.current || !hex) return;

      const source =
        selectedMode === "text"
          ? `UTF-8 文本 · ${formatBytes(textBytes)}`
          : `${selectedFile?.name ?? "文件"} · ${formatBytes(selectedFile?.size ?? 0)}`;

      setResult({ algorithm: selectedAlgorithm, hex, source });
      setFeedback({
        kind: "success",
        message: `${selectedAlgorithm} 摘要计算完成，用时 ${displayDuration(performance.now() - startedAt)}。`,
      });
    } catch (error) {
      if (requestId !== requestIdRef.current) return;
      setFeedback({
        kind: "error",
        message:
          error instanceof HashToolError
            ? error.message
            : "摘要计算失败，请重试。",
      });
    } finally {
      if (requestId === requestIdRef.current) setIsHashing(false);
    }
  }

  function compareExpected() {
    if (!result) {
      setComparison({ kind: "error", message: "请先计算摘要。" });
      return;
    }

    const comparisonResult = compareHashHex(
      result.hex,
      expected,
      result.algorithm,
    );

    if (!comparisonResult.ok) {
      setComparison({
        kind: "error",
        message: comparisonResult.error.message,
      });
      return;
    }

    setComparison(
      comparisonResult.matches
        ? { kind: "match", message: "摘要一致：内容与期望值匹配。" }
        : { kind: "mismatch", message: "摘要不一致：请检查内容或期望值。" },
    );
  }

  async function copyResult() {
    if (!result) return;
    if (!navigator.clipboard?.writeText) {
      setFeedback({
        kind: "error",
        message: "当前浏览器不支持剪贴板 API，请手动选择摘要复制。",
      });
      return;
    }

    try {
      await navigator.clipboard.writeText(result.hex);
      setFeedback({ kind: "success", message: "十六进制摘要已复制。" });
    } catch {
      setFeedback({
        kind: "error",
        message: "复制失败，请手动选择摘要复制。",
      });
    }
  }

  function downloadResult() {
    if (!result) return;

    const filename = `${result.algorithm.toLowerCase()}-digest.txt`;
    const blobUrl = URL.createObjectURL(
      new Blob([`${result.hex}\n`], { type: "text/plain;charset=utf-8" }),
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
    setInputMode("text");
    setText(SAMPLE_TEXT);
    invalidateResult("已载入官方测试向量常用文本 abc。");
  }

  function clearWorkspace() {
    requestIdRef.current += 1;
    setText("");
    setFile(null);
    setResult(null);
    setExpected("");
    setComparison(INITIAL_COMPARISON);
    setFeedback({
      kind: "idle",
      message: "输入、文件与摘要已从当前页面清空。",
    });
    setIsHashing(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  const hasComparisonError = comparison.kind === "error";

  return (
    <ToolWorkspace
      toolId="hash-generator"
      titleId={titleId}
      className="hash-tool"
      aria-busy={isHashing}
    >
      <ToolWorkspaceHeader className="hash-tool__heading">
        <div>
          <p className="eyebrow">交互区域</p>
          <h2 id={titleId}>SHA-256 / SHA-512 哈希计算</h2>
          <p className="hash-tool__intro">
            对 UTF-8 文本或任意文件生成小写十六进制摘要，并与期望值核对。
          </p>
        </div>
        <span className="hash-tool__security">Web Crypto · 本地</span>
      </ToolWorkspaceHeader>

      <aside className="hash-tool__notice" aria-label="哈希安全与隐私提示">
        <span aria-hidden="true">!</span>
        <div>
          <p>
            <strong>哈希不是加密，摘要无法用于隐藏或恢复原文。</strong>
            密码存储还需要专用的慢哈希与随机盐，不能直接使用 SHA-256。
          </p>
          <p>
            Web Crypto 只提供一次性摘要：文本上限 2 MiB、文件上限 20
            MiB，文件会完整读入内存。内容和文件名不上传、不写入持久化存储。
          </p>
        </div>
      </aside>

      <div className="hash-tool__toolbar" aria-label="哈希选项">
        <fieldset className="hash-tool__option">
          <legend>算法</legend>
          <div className="hash-tool__segments">
            {(["SHA-256", "SHA-512"] as const).map((value) => (
              <label key={value}>
                <input
                  type="radio"
                  name={algorithmName}
                  value={value}
                  checked={algorithm === value}
                  onChange={() => changeAlgorithm(value)}
                />
                <span>{value}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className="hash-tool__option">
          <legend>输入来源</legend>
          <div className="hash-tool__segments">
            {(
              [
                ["text", "文本输入"],
                ["file", "本地文件"],
              ] as const
            ).map(([value, label]) => (
              <label key={value}>
                <input
                  type="radio"
                  name={inputModeName}
                  value={value}
                  checked={inputMode === value}
                  onChange={() => changeInputMode(value)}
                />
                <span>{label}</span>
              </label>
            ))}
          </div>
        </fieldset>
      </div>

      <p className="hash-tool__shortcut">
        文本模式支持 <kbd>Ctrl</kbd>/<kbd>⌘</kbd> + <kbd>Enter</kbd>
        快速计算
      </p>

      <div className="hash-tool__workspace">
        <ToolWorkspaceRegion region="input" className="hash-tool__input-panel">
          <div className="hash-tool__panel-head">
            <span>{inputMode === "text" ? "待计算文本" : "待计算文件"}</span>
            <span className={textIsOverLimit ? "is-over" : undefined}>
              {inputMode === "text"
                ? `${formatBytes(textBytes)} / 2 MiB`
                : file
                  ? `${formatBytes(file.size)} / 20 MiB`
                  : "上限 20 MiB"}
            </span>
          </div>

          {inputMode === "text" ? (
            <textarea
              id={textInputId}
              className="hash-tool__textarea"
              value={text}
              onChange={(event) => updateText(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (
                  (event.ctrlKey || event.metaKey) &&
                  event.key === "Enter" &&
                  !event.nativeEvent.isComposing
                ) {
                  event.preventDefault();
                  void generateHash();
                }
              }}
              aria-label="UTF-8 文本"
              aria-describedby={`${inputHelpId} ${feedbackId}`}
              aria-errormessage={textIsOverLimit ? feedbackId : undefined}
              aria-invalid={textIsOverLimit || undefined}
              placeholder="输入文本；空文本也可以生成标准摘要"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              wrap="off"
              data-privacy-canary-input
            />
          ) : (
            <div
              className={`hash-tool__dropzone${isDragging ? " is-dragging" : ""}`}
              onDragEnter={(event) => {
                event.preventDefault();
                setIsDragging(true);
              }}
              onDragOver={(event) => event.preventDefault()}
              onDragLeave={(event) => {
                const nextTarget = event.relatedTarget;
                if (
                  !(nextTarget instanceof Node) ||
                  !event.currentTarget.contains(nextTarget)
                ) {
                  setIsDragging(false);
                }
              }}
              onDrop={handleDrop}
            >
              <input
                ref={fileInputRef}
                id={fileInputId}
                className="hash-tool__file-input"
                type="file"
                onChange={(event) =>
                  selectFile(event.currentTarget.files?.item(0) ?? null)
                }
              />
              <label className="button button--secondary" htmlFor={fileInputId}>
                选择本地文件
              </label>
              <p>{file ? file.name : "或将任意文件拖放到这里"}</p>
              <span>
                {file
                  ? `${formatBytes(file.size)} · 仅保留到刷新或清空`
                  : "选择后不会立即读取；点击计算时才会处理"}
              </span>
            </div>
          )}

          <p id={inputHelpId} className="hash-tool__help">
            {inputMode === "text"
              ? "文本严格按浏览器 UTF-8 编码结果计算；空文本也是有效输入。"
              : "支持任意文件类型；超限文件会在读取内容前被拒绝。"}
          </p>
        </ToolWorkspaceRegion>

        <ToolWorkspaceRegion
          region="output"
          className="hash-tool__output-panel"
        >
          <div className="hash-tool__panel-head">
            <label htmlFor={outputId}>
              {result?.algorithm ?? algorithm} 十六进制摘要
            </label>
            <span>{result ? `${result.hex.length} 字符` : "等待计算"}</span>
          </div>
          <textarea
            id={outputId}
            className="hash-tool__textarea hash-tool__textarea--output"
            value={result?.hex ?? ""}
            placeholder="摘要会显示在这里"
            readOnly
            spellCheck={false}
            wrap="off"
          />
          <p className="hash-tool__help">
            {result
              ? result.source
              : "输出为小写十六进制；SHA-256 为 64 字符，SHA-512 为 128 字符。"}
          </p>
        </ToolWorkspaceRegion>
      </div>

      <div
        id={feedbackId}
        className={`hash-tool__feedback hash-tool__feedback--${feedback.kind}`}
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

      <section
        className="hash-tool__compare"
        aria-labelledby={`${expectedId}-title`}
      >
        <div className="hash-tool__compare-heading">
          <div>
            <p className="eyebrow">摘要核对</p>
            <h3 id={`${expectedId}-title`}>与期望值比较</h3>
          </div>
          <span>{expectedLength} 个十六进制字符</span>
        </div>
        <div className="hash-tool__compare-row">
          <div>
            <label htmlFor={expectedId}>期望摘要</label>
            <input
              id={expectedId}
              className="hash-tool__expected"
              type="text"
              inputMode="text"
              value={expected}
              onChange={(event) => {
                setExpected(event.currentTarget.value);
                setComparison(INITIAL_COMPARISON);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  compareExpected();
                }
              }}
              aria-describedby={`${expectedHelpId} ${expectedId}-result`}
              aria-errormessage={
                hasComparisonError ? `${expectedId}-result` : undefined
              }
              aria-invalid={hasComparisonError || undefined}
              placeholder={`粘贴 ${result?.algorithm ?? algorithm} 摘要`}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
            />
          </div>
          <button
            className="button button--secondary"
            type="button"
            onClick={compareExpected}
            disabled={!result || !expected.trim()}
          >
            比较摘要
          </button>
        </div>
        <p id={expectedHelpId} className="hash-tool__help">
          比较过程遍历完整摘要且不中途返回；JavaScript
          运行时无法承诺严格恒定时间。
        </p>
        <p
          id={`${expectedId}-result`}
          className={`hash-tool__compare-result hash-tool__compare-result--${comparison.kind}`}
          aria-live="polite"
          aria-atomic="true"
        >
          {comparison.message}
        </p>
      </section>

      <ToolWorkspaceActions className="hash-tool__actions">
        <div className="hash-tool__actions-primary">
          <ToolWorkspaceAction
            action="execute"
            className="button button--primary"
            type="button"
            onClick={() => void generateHash()}
            disabled={!canHash}
            data-privacy-canary-action
          >
            {isHashing ? "正在计算…" : `计算 ${algorithm}`}
          </ToolWorkspaceAction>
        </div>
        <div className="hash-tool__actions-secondary">
          <ToolWorkspaceAction
            action="copy"
            className="button button--secondary"
            type="button"
            onClick={() => void copyResult()}
            disabled={!result}
          >
            复制摘要
          </ToolWorkspaceAction>
          <ToolWorkspaceAction
            action="download"
            className="button button--secondary"
            type="button"
            onClick={downloadResult}
            disabled={!result}
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
            disabled={!text && !file && !result && !expected}
          >
            清空
          </ToolWorkspaceAction>
        </div>
      </ToolWorkspaceActions>
    </ToolWorkspace>
  );
}

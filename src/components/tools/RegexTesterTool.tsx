import {
  useEffect,
  useId,
  useRef,
  useState,
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
  getRegexTextByteLength,
  REGEX_TESTER_LIMITS,
  SUPPORTED_REGEX_FLAGS,
  type RegexTestError,
  type RegexTestSuccess,
  type SupportedRegexFlag,
} from "../../tools/regex-tester/contract";
import {
  RegexWorkerClient,
  RegexWorkerClientError,
  type RegexWorkerTask,
} from "../../tools/regex-tester/worker-client";

const SAMPLE_PATTERN = String.raw`(?<word>\p{L}+)`;
const SAMPLE_SUBJECT =
  "Online Tools Hub 让 regex 测试保持本地。\nEmoji：你好 👋";
const MATCHES_PER_PAGE = 50;
const CAPTURES_PER_MATCH_PAGE = 16;

const flagLabels: Readonly<Record<SupportedRegexFlag, string>> = Object.freeze({
  g: "全局 g",
  i: "忽略大小写 i",
  m: "多行 m",
  s: "点号跨行 s",
  u: "Unicode u",
  v: "Unicode Sets v",
  y: "粘滞 y",
});

type Feedback = Readonly<{
  kind: "idle" | "success" | "warning" | "error";
  message: string;
}>;

const initialFeedback: Feedback = {
  kind: "idle",
  message: "只在点击运行后执行；pattern、测试文本和结果不会写入网址或存储。",
};

function byteLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KiB`;
}

function coreErrorFeedback(error: RegexTestError): Feedback {
  return { kind: "error", message: error.message };
}

function workerErrorFeedback(error: unknown): Feedback {
  if (error instanceof RegexWorkerClientError) {
    return {
      kind:
        error.code === "cancelled"
          ? "warning"
          : error.code === "timeout"
            ? "error"
            : "error",
      message: error.message,
    };
  }
  return {
    kind: "error",
    message: "正则测试未能完成，Worker 已安全释放。",
  };
}

function copyText(value: string): Promise<void> {
  if (!navigator.clipboard?.writeText) {
    return Promise.reject(new Error("Clipboard API unavailable"));
  }
  return navigator.clipboard.writeText(value);
}

export default function RegexTesterTool() {
  const titleId = useId();
  const patternId = useId();
  const subjectId = useId();
  const patternCountId = useId();
  const subjectCountId = useId();
  const feedbackId = useId();
  const [pattern, setPattern] = useState(SAMPLE_PATTERN);
  const [subject, setSubject] = useState(SAMPLE_SUBJECT);
  const [flags, setFlags] = useState("gu");
  const [result, setResult] = useState<RegexTestSuccess | null>(null);
  const [matchPage, setMatchPage] = useState(0);
  const [feedback, setFeedback] = useState<Feedback>(initialFeedback);
  const [running, setRunning] = useState(false);
  const clientRef = useRef<RegexWorkerClient | null>(null);
  const taskRef = useRef<RegexWorkerTask | null>(null);
  const mountedRef = useRef(false);

  if (clientRef.current === null) clientRef.current = new RegexWorkerClient();

  const patternBytes = getRegexTextByteLength(pattern);
  const subjectBytes = getRegexTextByteLength(subject);
  const patternOver = patternBytes > REGEX_TESTER_LIMITS.maxPatternBytes;
  const subjectOver = subjectBytes > REGEX_TESTER_LIMITS.maxSubjectBytes;
  const matchPageCount = result
    ? Math.max(1, Math.ceil(result.matches.length / MATCHES_PER_PAGE))
    : 1;
  const visibleMatches = result?.matches.slice(
    matchPage * MATCHES_PER_PAGE,
    (matchPage + 1) * MATCHES_PER_PAGE,
  );

  useEffect(() => {
    mountedRef.current = true;
    const client = clientRef.current;
    if (client) client.bindPageHide(window);
    return () => {
      mountedRef.current = false;
      taskRef.current = null;
      client?.dispose();
    };
  }, []);

  useEffect(() => {
    if (!running) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault();
      taskRef.current?.cancel();
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [running]);

  function invalidate(message: string, kind: Feedback["kind"] = "idle") {
    setResult(null);
    setMatchPage(0);
    setFeedback({ kind, message });
  }

  function updateFlag(flag: SupportedRegexFlag, checked: boolean) {
    const selected = new Set(flags);
    if (checked) selected.add(flag);
    else selected.delete(flag);
    if (flag === "u" && checked) selected.delete("v");
    if (flag === "v" && checked) selected.delete("u");
    const next = SUPPORTED_REGEX_FLAGS.filter((candidate) =>
      selected.has(candidate),
    ).join("");
    setFlags(next);
    invalidate("标志已更改，请重新运行测试。");
  }

  async function runTest() {
    if (running || taskRef.current !== null) return;
    if (patternOver || subjectOver) {
      setFeedback({
        kind: "error",
        message: patternOver
          ? "pattern 超过 8 KiB 上限，请缩短后重试。"
          : "测试文本超过 256 KiB 上限，请缩短后重试。",
      });
      return;
    }

    const client = clientRef.current;
    if (!client) return;
    setResult(null);
    setMatchPage(0);
    setRunning(true);
    setFeedback({
      kind: "idle",
      message: "正在独立 Worker 中运行；超过 2 秒将自动硬终止。",
    });

    let task: RegexWorkerTask | null = null;
    try {
      task = client.execute({ pattern, flags, subject });
      taskRef.current = task;
      const next = await task.result;
      if (!mountedRef.current || taskRef.current?.taskId !== task.taskId)
        return;
      if (!next.ok) {
        setFeedback(coreErrorFeedback(next.error));
        return;
      }
      setMatchPage(0);
      setResult(next);
      setFeedback({
        kind: next.truncated ? "warning" : "success",
        message: next.truncated
          ? `已返回前 ${next.matchLimit.toLocaleString("zh-CN")} 项，达到匹配数量上限。`
          : `测试完成，共找到 ${next.matches.length.toLocaleString("zh-CN")} 项匹配。`,
      });
    } catch (error) {
      if (mountedRef.current) setFeedback(workerErrorFeedback(error));
    } finally {
      if (mountedRef.current) {
        if (task === null) {
          setRunning(false);
        } else if (taskRef.current?.taskId === task.taskId) {
          taskRef.current = null;
          setRunning(false);
        }
      }
    }
  }

  function cancelTest() {
    taskRef.current?.cancel();
  }

  function loadExample() {
    setPattern(SAMPLE_PATTERN);
    setSubject(SAMPLE_SUBJECT);
    setFlags("gu");
    invalidate("安全示例已载入；点击运行查看 Unicode 与命名捕获组。");
  }

  function clearWorkspace() {
    setPattern("");
    setSubject("");
    setFlags("");
    setResult(null);
    setMatchPage(0);
    setFeedback({ kind: "idle", message: "pattern、测试文本和结果已清空。" });
  }

  async function copyResult() {
    if (!result) return;
    try {
      await copyText(JSON.stringify(result));
      setFeedback({ kind: "success", message: "匹配结果 JSON 已复制。" });
    } catch {
      setFeedback({
        kind: "error",
        message: "复制失败，请稍后重试；页面不会自动改用其他传输方式。",
      });
    }
  }

  function handleShortcut(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (
      (event.ctrlKey || event.metaKey) &&
      event.key === "Enter" &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      void runTest();
    }
  }

  return (
    <ToolWorkspace
      toolId="regex-tester"
      titleId={titleId}
      className="regex-tool"
    >
      <ToolWorkspaceHeader className="regex-tool__heading">
        <div>
          <p className="eyebrow">Dedicated Worker · 2 秒硬超时</p>
          <h2 id={titleId}>测试 JavaScript RegExp</h2>
        </div>
        <p>不会随输入自动运行；取消、超时或离开页面都会直接销毁 Worker。</p>
      </ToolWorkspaceHeader>

      <ToolWorkspaceRegion region="input" className="regex-tool__input-grid">
        <div className="regex-tool__field regex-tool__field--pattern">
          <div className="regex-tool__field-head">
            <label htmlFor={patternId}>Pattern</label>
            <span
              id={patternCountId}
              className={patternOver ? "is-over" : undefined}
            >
              {byteLabel(patternBytes)} / 8 KiB
            </span>
          </div>
          <textarea
            id={patternId}
            value={pattern}
            rows={4}
            spellCheck={false}
            aria-invalid={patternOver}
            aria-describedby={`${patternCountId} ${feedbackId}`}
            aria-keyshortcuts="Control+Enter Meta+Enter Escape"
            data-privacy-canary-input
            readOnly={running}
            onKeyDown={handleShortcut}
            onChange={(event) => {
              const nextPattern = event.target.value;
              setPattern(nextPattern);
              const overLimit =
                getRegexTextByteLength(nextPattern) >
                REGEX_TESTER_LIMITS.maxPatternBytes;
              invalidate(
                overLimit
                  ? "pattern 超过 8 KiB 上限，请缩短后重试。"
                  : "pattern 已更改，请重新运行测试。",
                overLimit ? "error" : "idle",
              );
            }}
          />
        </div>

        <fieldset className="regex-tool__flags" disabled={running}>
          <legend>Flags</legend>
          <div>
            {SUPPORTED_REGEX_FLAGS.map((flag) => (
              <label key={flag}>
                <input
                  type="checkbox"
                  checked={flags.includes(flag)}
                  onChange={(event) => updateFlag(flag, event.target.checked)}
                />
                <span>{flagLabels[flag]}</span>
              </label>
            ))}
          </div>
          <p>u 与 v 互斥；g / y 会继续查找，零宽匹配按 Unicode 安全推进。</p>
        </fieldset>

        <div className="regex-tool__field regex-tool__field--subject">
          <div className="regex-tool__field-head">
            <label htmlFor={subjectId}>测试文本</label>
            <span
              id={subjectCountId}
              className={subjectOver ? "is-over" : undefined}
            >
              {byteLabel(subjectBytes)} / 256 KiB
            </span>
          </div>
          <textarea
            id={subjectId}
            value={subject}
            rows={10}
            spellCheck={false}
            aria-invalid={subjectOver}
            aria-describedby={`${subjectCountId} ${feedbackId}`}
            aria-keyshortcuts="Control+Enter Meta+Enter Escape"
            data-privacy-canary-input
            readOnly={running}
            onKeyDown={handleShortcut}
            onChange={(event) => {
              const nextSubject = event.target.value;
              setSubject(nextSubject);
              const overLimit =
                getRegexTextByteLength(nextSubject) >
                REGEX_TESTER_LIMITS.maxSubjectBytes;
              invalidate(
                overLimit
                  ? "测试文本超过 256 KiB 上限，请缩短后重试。"
                  : "测试文本已更改，请重新运行测试。",
                overLimit ? "error" : "idle",
              );
            }}
          />
        </div>
      </ToolWorkspaceRegion>

      <div
        id={feedbackId}
        className={`regex-tool__feedback regex-tool__feedback--${feedback.kind}`}
        role={feedback.kind === "error" ? "alert" : "status"}
        aria-live={feedback.kind === "error" ? "assertive" : "polite"}
        data-regex-status={running ? "running" : feedback.kind}
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

      <ToolWorkspaceRegion region="output" className="regex-tool__output">
        {result ? (
          <>
            <div className="regex-tool__result-head">
              <div>
                <p className="eyebrow">匹配结果</p>
                <h3>{result.matches.length.toLocaleString("zh-CN")} 项</h3>
              </div>
              <ul aria-label="结果统计">
                <li>flags {result.flags ? `/${result.flags}` : "无"}</li>
                <li>紧凑 JSON {byteLabel(result.outputBytes)}</li>
                <li>最多 {result.matchLimit.toLocaleString("zh-CN")} 项</li>
              </ul>
            </div>
            {result.matches.length === 0 ? (
              <div className="regex-tool__empty">
                <h3>没有匹配项</h3>
                <p>检查 pattern、flags 与测试文本后再次运行。</p>
              </div>
            ) : (
              <>
                {matchPageCount > 1 && (
                  <nav
                    className="regex-tool__pagination"
                    aria-label="匹配结果分页"
                  >
                    <button
                      className="button button--quiet"
                      type="button"
                      disabled={matchPage === 0}
                      onClick={() =>
                        setMatchPage((page) => Math.max(0, page - 1))
                      }
                    >
                      上一页
                    </button>
                    <span aria-live="polite">
                      第 {matchPage + 1} / {matchPageCount} 页
                    </span>
                    <button
                      className="button button--quiet"
                      type="button"
                      disabled={matchPage + 1 >= matchPageCount}
                      onClick={() =>
                        setMatchPage((page) =>
                          Math.min(matchPageCount - 1, page + 1),
                        )
                      }
                    >
                      下一页
                    </button>
                  </nav>
                )}
                <ol
                  className="regex-tool__matches"
                  tabIndex={0}
                  aria-label={`匹配结果，第 ${matchPage + 1} 页，共 ${matchPageCount} 页`}
                >
                  {visibleMatches?.map((match) => {
                    const hiddenCaptures = Math.max(
                      0,
                      match.captures.length - CAPTURES_PER_MATCH_PAGE,
                    );
                    const hiddenNamedCaptures = Math.max(
                      0,
                      match.namedCaptures.length - CAPTURES_PER_MATCH_PAGE,
                    );
                    return (
                      <li key={`${match.ordinal}-${match.index}-${match.end}`}>
                        <div className="regex-tool__match-head">
                          <strong>匹配 {match.ordinal}</strong>
                          <span>
                            UTF-16 索引 [{match.index}, {match.end})
                          </span>
                        </div>
                        <pre>
                          <code>
                            {match.text === "" ? "（零宽匹配）" : match.text}
                          </code>
                        </pre>
                        {match.captures.length > 0 && (
                          <dl className="regex-tool__captures">
                            {match.captures
                              .slice(0, CAPTURES_PER_MATCH_PAGE)
                              .map((capture, index) => (
                                <div key={index}>
                                  <dt>${index + 1}</dt>
                                  <dd>
                                    {capture === null
                                      ? "（未参与）"
                                      : capture === ""
                                        ? "（空字符串）"
                                        : capture}
                                  </dd>
                                </div>
                              ))}
                          </dl>
                        )}
                        {hiddenCaptures > 0 && (
                          <p className="regex-tool__capture-note">
                            另有 {hiddenCaptures} 个编号捕获未展开；复制紧凑
                            JSON 可获取完整结果。
                          </p>
                        )}
                        {match.namedCaptures.length > 0 && (
                          <dl className="regex-tool__captures regex-tool__captures--named">
                            {match.namedCaptures
                              .slice(0, CAPTURES_PER_MATCH_PAGE)
                              .map((capture) => (
                                <div key={capture.name}>
                                  <dt>{capture.name}</dt>
                                  <dd>
                                    {capture.value === null
                                      ? "（未参与）"
                                      : capture.value === ""
                                        ? "（空字符串）"
                                        : capture.value}
                                  </dd>
                                </div>
                              ))}
                          </dl>
                        )}
                        {hiddenNamedCaptures > 0 && (
                          <p className="regex-tool__capture-note">
                            另有 {hiddenNamedCaptures}{" "}
                            个命名捕获未展开；复制紧凑 JSON 可获取完整结果。
                          </p>
                        )}
                      </li>
                    );
                  })}
                </ol>
              </>
            )}
          </>
        ) : (
          <div className="regex-tool__empty">
            <h3>
              {running
                ? "正在等待 Worker"
                : feedback.kind === "error" || feedback.kind === "warning"
                  ? "本次未生成结果"
                  : "等待主动运行"}
            </h3>
            <p>
              {running
                ? "计算正在隔离线程中进行，可按 Escape 或点击取消并释放临时状态。"
                : feedback.kind === "error" || feedback.kind === "warning"
                  ? "请根据上方状态调整输入或重新运行；失败内容不会被保留。"
                  : "结果只保留在当前标签页内存，不会恢复或同步。"}
            </p>
          </div>
        )}
      </ToolWorkspaceRegion>

      <ToolWorkspaceActions className="regex-tool__actions">
        {running ? (
          <ToolWorkspaceAction
            action="cancel"
            className="button button--primary"
            type="button"
            aria-keyshortcuts="Escape"
            onClick={cancelTest}
          >
            取消并终止 Worker
          </ToolWorkspaceAction>
        ) : (
          <ToolWorkspaceAction
            action="execute"
            className="button button--primary"
            type="button"
            disabled={patternOver || subjectOver}
            data-privacy-canary-action
            onClick={() => void runTest()}
          >
            运行正则测试
          </ToolWorkspaceAction>
        )}
        <ToolWorkspaceAction
          action="copy"
          className="button button--secondary"
          type="button"
          disabled={running || !result}
          onClick={() => void copyResult()}
        >
          复制结果 JSON
        </ToolWorkspaceAction>
        <ToolWorkspaceAction
          action="example"
          className="button button--quiet"
          type="button"
          disabled={running}
          onClick={loadExample}
        >
          载入安全示例
        </ToolWorkspaceAction>
        <ToolWorkspaceAction
          action="clear"
          className="button button--quiet"
          type="button"
          disabled={running}
          onClick={clearWorkspace}
        >
          清空
        </ToolWorkspaceAction>
        <span className="regex-tool__shortcut">
          <kbd>Ctrl</kbd>/<kbd>⌘</kbd> + <kbd>Enter</kbd>
          <span aria-hidden="true"> · </span>运行中 <kbd>Esc</kbd> 取消
        </span>
      </ToolWorkspaceActions>
    </ToolWorkspace>
  );
}

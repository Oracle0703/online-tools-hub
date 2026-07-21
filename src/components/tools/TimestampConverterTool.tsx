import { useId, useState, useSyncExternalStore } from "react";

import { ToolWorkspace, ToolWorkspaceHeader } from "../ToolWorkspace";
import {
  convertDateTime,
  convertTimestamp,
  getLocalTimeZone,
  toDateTimeLocalValue,
  type DateTimeInterpretation,
  type TimestampDetails,
  type TimestampUnit,
} from "../../tools/timestamp-converter";

type Feedback = {
  kind: "idle" | "success" | "error";
  message: string;
  source?: "timestamp" | "dateTime";
};

const INITIAL_FEEDBACK: Feedback = {
  kind: "idle",
  message: "所有日期和时间转换都只在当前浏览器中完成。",
};

const subscribeToTimeZone = () => () => {};
const getServerTimeZone = () => "浏览器本地时区";

type ResultTableProps = {
  title: string;
  result: TimestampDetails;
  onCopy: (label: string, value: string) => void;
};

function ResultTable({ title, result, onCopy }: ResultTableProps) {
  const titleId = useId();
  const rows = [
    ["Unix 秒", String(result.seconds)],
    ["Unix 毫秒", String(result.milliseconds)],
    [`本地时间 · ${result.timeZone}`, result.local],
    ["UTC", result.utc],
    ["ISO 8601", result.iso],
  ] as const;

  return (
    <section
      className="timestamp-tool__results"
      aria-labelledby={titleId}
      data-tool-region="output"
    >
      <h4 id={titleId}>{title}</h4>
      <dl>
        {rows.map(([label, value]) => (
          <div className="timestamp-tool__result-row" key={label}>
            <dt>{label}</dt>
            <dd>
              <code>{value}</code>
            </dd>
            <button
              className="button button--quiet timestamp-tool__copy"
              type="button"
              onClick={() => onCopy(label, value)}
              aria-label={`复制${label}`}
              data-tool-action="copy"
            >
              复制
            </button>
          </div>
        ))}
      </dl>
    </section>
  );
}

export default function TimestampConverterTool() {
  const titleId = useId();
  const timestampInputId = useId();
  const dateTimeInputId = useId();
  const feedbackId = useId();

  const timeZone = useSyncExternalStore(
    subscribeToTimeZone,
    getLocalTimeZone,
    getServerTimeZone,
  );
  const [timestamp, setTimestamp] = useState("");
  const [unit, setUnit] = useState<TimestampUnit>("auto");
  const [timestampResult, setTimestampResult] =
    useState<TimestampDetails | null>(null);
  const [dateTime, setDateTime] = useState("");
  const [interpretation, setInterpretation] =
    useState<DateTimeInterpretation>("local");
  const [dateTimeResult, setDateTimeResult] = useState<TimestampDetails | null>(
    null,
  );
  const [feedback, setFeedback] = useState<Feedback>(INITIAL_FEEDBACK);

  function applyTimestamp(value: string | number, selectedUnit: TimestampUnit) {
    const result = convertTimestamp(value, selectedUnit);
    if (!result.ok) {
      setTimestampResult(null);
      setFeedback({
        kind: "error",
        message: result.error.message,
        source: "timestamp",
      });
      return;
    }

    setTimestampResult(result.value);
    setFeedback({
      kind: "success",
      message: `转换完成，输入按${result.value.resolvedUnit === "seconds" ? "秒" : "毫秒"}处理。`,
    });
  }

  function applyDateTime() {
    const result = convertDateTime(dateTime, interpretation);
    if (!result.ok) {
      setDateTimeResult(null);
      setFeedback({
        kind: "error",
        message: result.error.message,
        source: "dateTime",
      });
      return;
    }

    setDateTimeResult(result.value);
    setFeedback({
      kind: "success",
      message: `已将日期按${interpretation === "local" ? `本地时区 ${result.value.timeZone}` : "UTC"}转换为 Unix 时间戳。`,
    });
  }

  async function copyValue(label: string, value: string) {
    if (!navigator.clipboard?.writeText) {
      setFeedback({
        kind: "error",
        message: "当前浏览器不支持剪贴板 API，请手动选择结果复制。",
      });
      return;
    }

    try {
      await navigator.clipboard.writeText(value);
      setFeedback({ kind: "success", message: `${label}已复制。` });
    } catch {
      setFeedback({
        kind: "error",
        message: "复制失败，请手动选择结果复制。",
      });
    }
  }

  function useCurrentTimestamp() {
    const now = Date.now();
    setTimestamp(String(now));
    setUnit("milliseconds");
    applyTimestamp(now, "milliseconds");
  }

  function useCurrentDateTime() {
    setDateTime(toDateTimeLocalValue(new Date(), interpretation));
    setDateTimeResult(null);
    setFeedback({ kind: "idle", message: "已填入当前时间，可以开始转换。" });
  }

  function clearWorkspace() {
    setTimestamp("");
    setTimestampResult(null);
    setDateTime("");
    setDateTimeResult(null);
    setFeedback({ kind: "idle", message: "输入和转换结果已清空。" });
  }

  return (
    <ToolWorkspace
      toolId="unix-timestamp"
      titleId={titleId}
      className="timestamp-tool"
    >
      <ToolWorkspaceHeader className="timestamp-tool__heading">
        <div>
          <p className="eyebrow">交互区域</p>
          <h2 id={titleId}>Unix 时间戳与日期时间互转</h2>
          <p className="timestamp-tool__intro">
            自动识别秒或毫秒，也可手动指定；同时输出本地时间、UTC 和 ISO 8601。
          </p>
        </div>
        <span className="timestamp-tool__zone" title="浏览器当前时区">
          当前时区：{timeZone}
        </span>
      </ToolWorkspaceHeader>

      <div className="timestamp-tool__panels">
        <section
          className="timestamp-tool__panel"
          aria-labelledby={`${timestampInputId}-title`}
        >
          <div className="timestamp-tool__panel-heading">
            <span aria-hidden="true">01</span>
            <div>
              <h3 id={`${timestampInputId}-title`}>时间戳转换为日期</h3>
              <p>负值和 1970 年以前的时间同样支持。</p>
            </div>
          </div>

          <div className="timestamp-tool__control" data-tool-region="input">
            <label htmlFor={timestampInputId}>Unix 时间戳</label>
            <input
              id={timestampInputId}
              className="timestamp-tool__input"
              type="text"
              inputMode="decimal"
              value={timestamp}
              onChange={(event) => {
                setTimestamp(event.currentTarget.value);
                setTimestampResult(null);
                setFeedback(INITIAL_FEEDBACK);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  applyTimestamp(timestamp, unit);
                }
              }}
              placeholder="例如 1710000000 或 1710000000000"
              aria-describedby={feedbackId}
              aria-invalid={
                (feedback.kind === "error" &&
                  feedback.source === "timestamp") ||
                undefined
              }
              autoComplete="off"
              spellCheck={false}
              data-privacy-canary-input
            />
          </div>

          <fieldset className="timestamp-tool__fieldset">
            <legend>输入单位</legend>
            <div className="timestamp-tool__segments">
              {(
                [
                  ["auto", "自动识别"],
                  ["seconds", "秒"],
                  ["milliseconds", "毫秒"],
                ] as const
              ).map(([value, label]) => (
                <label key={value}>
                  <input
                    type="radio"
                    name="timestamp-unit"
                    checked={unit === value}
                    onChange={() => {
                      setUnit(value);
                      setTimestampResult(null);
                    }}
                  />
                  <span>{label}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="timestamp-tool__panel-actions">
            <button
              className="button button--primary"
              type="button"
              disabled={!timestamp.trim()}
              onClick={() => applyTimestamp(timestamp, unit)}
              data-privacy-canary-action
              data-tool-action="execute"
            >
              转换时间戳
            </button>
            <button
              className="button button--secondary"
              type="button"
              onClick={useCurrentTimestamp}
              data-tool-action="example"
            >
              使用当前时间戳
            </button>
          </div>

          {timestampResult ? (
            <ResultTable
              title="时间戳转换结果"
              result={timestampResult}
              onCopy={copyValue}
            />
          ) : null}
        </section>

        <section
          className="timestamp-tool__panel"
          aria-labelledby={`${dateTimeInputId}-title`}
        >
          <div className="timestamp-tool__panel-heading">
            <span aria-hidden="true">02</span>
            <div>
              <h3 id={`${dateTimeInputId}-title`}>日期生成时间戳</h3>
              <p>明确选择输入时间代表本地时间还是 UTC。</p>
            </div>
          </div>

          <div className="timestamp-tool__control" data-tool-region="input">
            <label htmlFor={dateTimeInputId}>日期与时间</label>
            <input
              id={dateTimeInputId}
              className="timestamp-tool__input"
              type="datetime-local"
              step="0.001"
              value={dateTime}
              onChange={(event) => {
                setDateTime(event.currentTarget.value);
                setDateTimeResult(null);
                setFeedback(INITIAL_FEEDBACK);
              }}
              aria-describedby={feedbackId}
              aria-invalid={
                (feedback.kind === "error" && feedback.source === "dateTime") ||
                undefined
              }
              data-privacy-canary-input
            />
          </div>

          <fieldset className="timestamp-tool__fieldset">
            <legend>将输入解释为</legend>
            <div className="timestamp-tool__segments">
              {(
                [
                  ["local", `本地时间`],
                  ["utc", "UTC"],
                ] as const
              ).map(([value, label]) => (
                <label key={value}>
                  <input
                    type="radio"
                    name="date-time-interpretation"
                    checked={interpretation === value}
                    onChange={() => {
                      setInterpretation(value);
                      setDateTimeResult(null);
                    }}
                  />
                  <span>{label}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="timestamp-tool__panel-actions">
            <button
              className="button button--primary"
              type="button"
              disabled={!dateTime}
              onClick={applyDateTime}
              data-privacy-canary-action
              data-tool-action="execute"
            >
              生成时间戳
            </button>
            <button
              className="button button--secondary"
              type="button"
              onClick={useCurrentDateTime}
              data-tool-action="example"
            >
              使用当前日期
            </button>
          </div>

          {dateTimeResult ? (
            <ResultTable
              title="日期转换结果"
              result={dateTimeResult}
              onCopy={copyValue}
            />
          ) : null}
        </section>
      </div>

      <div
        id={feedbackId}
        className={`timestamp-tool__feedback timestamp-tool__feedback--${feedback.kind}`}
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

      <div
        className="workspace-actions timestamp-tool__footer-actions"
        data-tool-region="actions"
      >
        <button
          className="button button--quiet"
          type="button"
          onClick={clearWorkspace}
          disabled={
            !timestamp && !dateTime && !timestampResult && !dateTimeResult
          }
          data-tool-action="clear"
        >
          清空全部
        </button>
      </div>
    </ToolWorkspace>
  );
}

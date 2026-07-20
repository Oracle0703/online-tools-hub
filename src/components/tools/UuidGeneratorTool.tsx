import { useId, useState } from "react";

import { ToolWorkspace, ToolWorkspaceHeader } from "../ToolWorkspace";
import {
  generateUuidV4,
  MAX_UUID_COUNT,
  MIN_UUID_COUNT,
} from "../../tools/uuid-generator";

type Feedback = {
  kind: "idle" | "success" | "error";
  message: string;
};

const INITIAL_FEEDBACK: Feedback = {
  kind: "idle",
  message: "UUID 使用浏览器密码学安全随机源生成，不会上传或保存。",
};

export default function UuidGeneratorTool() {
  const titleId = useId();
  const countId = useId();
  const feedbackId = useId();
  const resultsTitleId = useId();

  const [countInput, setCountInput] = useState("1");
  const [values, setValues] = useState<string[]>([]);
  const [feedback, setFeedback] = useState<Feedback>(INITIAL_FEEDBACK);

  function generate() {
    const result = generateUuidV4(Number(countInput));
    if (!result.ok) {
      setValues([]);
      setFeedback({ kind: "error", message: result.error.message });
      return;
    }

    setValues(result.value);
    setFeedback({
      kind: "success",
      message: `已生成 ${result.value.length} 个格式正确且互不重复的 UUID v4。`,
    });
  }

  async function copyText(value: string, successMessage: string) {
    if (!navigator.clipboard?.writeText) {
      setFeedback({
        kind: "error",
        message: "当前浏览器不支持剪贴板 API，请手动选择结果复制。",
      });
      return;
    }

    try {
      await navigator.clipboard.writeText(value);
      setFeedback({ kind: "success", message: successMessage });
    } catch {
      setFeedback({
        kind: "error",
        message: "复制失败，请手动选择结果复制。",
      });
    }
  }

  function downloadValues() {
    if (!values.length) return;

    const blobUrl = URL.createObjectURL(
      new Blob([`${values.join("\n")}\n`], {
        type: "text/plain;charset=utf-8",
      }),
    );
    const link = document.createElement("a");
    link.href = blobUrl;
    link.download = values.length === 1 ? "uuid-v4.txt" : "uuid-v4-list.txt";
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(blobUrl), 0);
    setFeedback({
      kind: "success",
      message: `已下载 ${values.length} 个 UUID。`,
    });
  }

  function clearWorkspace() {
    setValues([]);
    setFeedback({ kind: "idle", message: "生成结果已清空。" });
  }

  const numericCount = Number(countInput);
  const countIsValid =
    Number.isInteger(numericCount) &&
    numericCount >= MIN_UUID_COUNT &&
    numericCount <= MAX_UUID_COUNT;

  return (
    <ToolWorkspace
      toolId="uuid-generator"
      titleId={titleId}
      className="uuid-tool"
    >
      <ToolWorkspaceHeader className="uuid-tool__heading">
        <div>
          <p className="eyebrow">交互区域</p>
          <h2 id={titleId}>密码学安全 UUID v4 生成器</h2>
          <p className="uuid-tool__intro">
            一次生成 1–1,000 个标准 UUID v4，自动校验格式并排除重复值。
          </p>
        </div>
        <span className="uuid-tool__security">安全随机源</span>
      </ToolWorkspaceHeader>

      <div className="uuid-tool__controls" data-tool-region="input">
        <div className="uuid-tool__count-control">
          <label htmlFor={countId}>生成数量</label>
          <div className="uuid-tool__count-row">
            <input
              id={countId}
              className="uuid-tool__input"
              type="number"
              inputMode="numeric"
              min={MIN_UUID_COUNT}
              max={MAX_UUID_COUNT}
              step="1"
              value={countInput}
              onChange={(event) => {
                setCountInput(event.currentTarget.value);
                setFeedback(INITIAL_FEEDBACK);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  generate();
                }
              }}
              aria-describedby={`${countId}-help ${feedbackId}`}
              aria-invalid={!countIsValid || undefined}
              data-privacy-canary-input
            />
            <button
              className="button button--primary"
              type="button"
              onClick={generate}
              disabled={!countIsValid}
              data-privacy-canary-action
              data-tool-action="execute"
            >
              生成 UUID
            </button>
          </div>
          <p id={`${countId}-help`} className="uuid-tool__help">
            请输入 {MIN_UUID_COUNT}–{MAX_UUID_COUNT} 之间的整数。
          </p>
        </div>

        <fieldset className="uuid-tool__presets">
          <legend>快速选择</legend>
          <div>
            {[1, 5, 10, 100, 1_000].map((count) => (
              <button
                className="button button--quiet"
                type="button"
                key={count}
                onClick={() => {
                  setCountInput(String(count));
                  setFeedback(INITIAL_FEEDBACK);
                }}
                aria-pressed={numericCount === count}
                data-tool-action="example"
              >
                {count}
              </button>
            ))}
          </div>
        </fieldset>
      </div>

      <div
        id={feedbackId}
        className={`uuid-tool__feedback uuid-tool__feedback--${feedback.kind}`}
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
        className="uuid-tool__results"
        aria-labelledby={resultsTitleId}
        data-tool-region="output"
      >
        <div className="uuid-tool__results-heading">
          <div>
            <p className="eyebrow">生成结果</p>
            <h3 id={resultsTitleId}>
              {values.length ? `${values.length} 个 UUID v4` : "等待生成"}
            </h3>
          </div>
          <div className="uuid-tool__result-actions" data-tool-region="actions">
            <button
              className="button button--secondary"
              type="button"
              disabled={!values.length}
              onClick={() =>
                copyText(
                  values.join("\n"),
                  `已复制全部 ${values.length} 个 UUID。`,
                )
              }
              data-tool-action="copy"
            >
              复制全部
            </button>
            <button
              className="button button--secondary"
              type="button"
              disabled={!values.length}
              onClick={downloadValues}
              data-tool-action="download"
            >
              下载 .txt
            </button>
            <button
              className="button button--quiet"
              type="button"
              disabled={!values.length}
              onClick={clearWorkspace}
              data-tool-action="clear"
            >
              清空
            </button>
          </div>
        </div>

        {values.length ? (
          <ol className="uuid-tool__list">
            {values.map((uuid, index) => (
              <li key={uuid}>
                <span className="uuid-tool__index" aria-hidden="true">
                  {index + 1}
                </span>
                <code>{uuid}</code>
                <button
                  className="button button--quiet uuid-tool__copy"
                  type="button"
                  onClick={() =>
                    copyText(uuid, `第 ${index + 1} 个 UUID 已复制。`)
                  }
                  aria-label={`复制第 ${index + 1} 个 UUID`}
                  data-tool-action="copy"
                >
                  复制
                </button>
              </li>
            ))}
          </ol>
        ) : (
          <div className="uuid-tool__empty">
            <span aria-hidden="true">ID</span>
            <p>选择数量并生成，结果将在这里逐项显示。</p>
          </div>
        )}
      </section>
    </ToolWorkspace>
  );
}

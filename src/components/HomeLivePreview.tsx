import { useId, useMemo, useRef, useState, type KeyboardEvent } from "react";

import { encodeBase64 } from "../tools/base64-codec";
import { formatJson } from "../tools/json-formatter";

import "./HomeLivePreview.css";

const tasks = [
  {
    id: "json",
    label: "JSON",
    title: "JSON 格式化",
    slug: "json-formatter",
  },
  {
    id: "base64",
    label: "Base64",
    title: "Base64 编解码",
    slug: "base64-codec",
  },
  {
    id: "image",
    label: "图片压缩",
    title: "图片压缩",
    slug: "image-compressor",
  },
] as const;

type TaskId = (typeof tasks)[number]["id"];

type Props = {
  baseUrl: string;
};

type PreviewResult =
  | { state: "idle"; output: ""; message: string }
  | { state: "ready"; output: string; message: string }
  | { state: "error"; output: ""; message: string };

const INITIAL_JSON =
  '{"project":"Online Tools Hub","privacy":"local","ready":true}';
const INITIAL_BASE64 = "数据留在浏览器里。";

function toolHref(baseUrl: string, slug: string): string {
  const normalizedBase = baseUrl.replace(/\/+$/u, "");
  return `${normalizedBase}/tools/${slug}/`;
}

export default function HomeLivePreview({ baseUrl }: Props) {
  const componentId = useId();
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [activeTask, setActiveTask] = useState<TaskId>("json");
  const [jsonInput, setJsonInput] = useState(INITIAL_JSON);
  const [base64Input, setBase64Input] = useState(INITIAL_BASE64);

  const jsonPreview = useMemo<PreviewResult>(() => {
    if (!jsonInput.trim()) {
      return {
        state: "idle",
        output: "",
        message: "输入 JSON 后，这里会显示实时格式化结果。",
      };
    }

    const result = formatJson(jsonInput, 2);
    if (!result.ok) {
      return {
        state: "error",
        output: "",
        message: `JSON 有误：第 ${result.error.line} 行，第 ${result.error.column} 列。`,
      };
    }

    return {
      state: "ready",
      output: result.value,
      message: "已在浏览器中实时格式化。",
    };
  }, [jsonInput]);

  const base64Preview = useMemo<PreviewResult>(() => {
    if (!base64Input) {
      return {
        state: "idle",
        output: "",
        message: "输入文本后，这里会显示实时 Base64 编码。",
      };
    }

    try {
      return {
        state: "ready",
        output: encodeBase64(base64Input),
        message: "已在浏览器中按 UTF-8 实时编码。",
      };
    } catch {
      return {
        state: "error",
        output: "",
        message: "输入包含无法无损转换为 UTF-8 的字符。",
      };
    }
  }, [base64Input]);

  const selectedTask = tasks.find((task) => task.id === activeTask) ?? tasks[0];

  function selectTab(index: number) {
    const task = tasks[index];
    if (!task) return;

    setActiveTask(task.id);
    tabRefs.current[index]?.focus();
  }

  function handleTabKeyDown(
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) {
    let nextIndex: number | undefined;

    if (event.key === "ArrowRight") {
      nextIndex = (index + 1) % tasks.length;
    } else if (event.key === "ArrowLeft") {
      nextIndex = (index - 1 + tasks.length) % tasks.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = tasks.length - 1;
    }

    if (nextIndex === undefined) return;

    event.preventDefault();
    selectTab(nextIndex);
  }

  return (
    <section
      className="home-live-preview"
      aria-labelledby={`${componentId}-title`}
    >
      <header className="home-live-preview__header">
        <div>
          <p className="home-live-preview__kicker">即时试用</p>
          <h2 id={`${componentId}-title`}>输入一点，立即看到结果</h2>
        </div>
        <span className="home-live-preview__local">
          <span aria-hidden="true" />
          本地处理
        </span>
      </header>

      <div
        className="home-live-preview__tabs"
        role="tablist"
        aria-label="选择预览任务"
      >
        {tasks.map((task, index) => {
          const isActive = task.id === activeTask;

          return (
            <button
              key={task.id}
              ref={(element) => {
                tabRefs.current[index] = element;
              }}
              id={`${componentId}-${task.id}-tab`}
              type="button"
              role="tab"
              aria-selected={isActive}
              aria-controls={`${componentId}-${task.id}-panel`}
              tabIndex={isActive ? 0 : -1}
              onClick={() => setActiveTask(task.id)}
              onKeyDown={(event) => handleTabKeyDown(event, index)}
            >
              {task.label}
            </button>
          );
        })}
      </div>

      <div
        id={`${componentId}-json-panel`}
        className="home-live-preview__panel"
        role="tabpanel"
        aria-labelledby={`${componentId}-json-tab`}
        hidden={activeTask !== "json"}
      >
        <label className="home-live-preview__field">
          <span>输入</span>
          <textarea
            value={jsonInput}
            rows={4}
            spellCheck={false}
            aria-invalid={jsonPreview.state === "error"}
            aria-describedby={`${componentId}-json-status`}
            onChange={(event) => setJsonInput(event.target.value)}
          />
        </label>

        <div className="home-live-preview__result">
          <div className="home-live-preview__result-head">
            <span>格式化结果</span>
            <span
              id={`${componentId}-json-status`}
              className={`home-live-preview__status home-live-preview__status--${jsonPreview.state}`}
              role="status"
              aria-live="polite"
              aria-atomic="true"
            >
              {jsonPreview.message}
            </span>
          </div>
          <pre tabIndex={0} aria-label="JSON 格式化结果">
            {jsonPreview.output || "等待有效输入…"}
          </pre>
        </div>
      </div>

      <div
        id={`${componentId}-base64-panel`}
        className="home-live-preview__panel"
        role="tabpanel"
        aria-labelledby={`${componentId}-base64-tab`}
        hidden={activeTask !== "base64"}
      >
        <label className="home-live-preview__field">
          <span>UTF-8 文本</span>
          <textarea
            value={base64Input}
            rows={4}
            spellCheck={false}
            aria-invalid={base64Preview.state === "error"}
            aria-describedby={`${componentId}-base64-status`}
            onChange={(event) => setBase64Input(event.target.value)}
          />
        </label>

        <div className="home-live-preview__result">
          <div className="home-live-preview__result-head">
            <span>Base64 编码</span>
            <span
              id={`${componentId}-base64-status`}
              className={`home-live-preview__status home-live-preview__status--${base64Preview.state}`}
              role="status"
              aria-live="polite"
              aria-atomic="true"
            >
              {base64Preview.message}
            </span>
          </div>
          <pre tabIndex={0} aria-label="Base64 编码结果">
            {base64Preview.output || "等待输入…"}
          </pre>
        </div>
      </div>

      <div
        id={`${componentId}-image-panel`}
        className="home-live-preview__panel home-live-preview__panel--image"
        role="tabpanel"
        aria-labelledby={`${componentId}-image-tab`}
        hidden={activeTask !== "image"}
      >
        <div className="home-live-preview__example-label">
          <span>能力示例</span>
          此处未读取或处理图片
        </div>

        <div
          className="home-live-preview__image-flow"
          aria-label="完整工具的处理流程示例"
        >
          <div>
            <span className="home-live-preview__flow-mark" aria-hidden="true">
              IMG
            </span>
            <strong>选择图片</strong>
            <small>JPEG · PNG · WebP</small>
          </div>
          <span className="home-live-preview__flow-arrow" aria-hidden="true">
            →
          </span>
          <div>
            <span className="home-live-preview__flow-mark" aria-hidden="true">
              %
            </span>
            <strong>调整参数</strong>
            <small>质量 · 尺寸 · 格式</small>
          </div>
          <span className="home-live-preview__flow-arrow" aria-hidden="true">
            →
          </span>
          <div>
            <span className="home-live-preview__flow-mark" aria-hidden="true">
              ↓
            </span>
            <strong>预览并下载</strong>
            <small>结果由真实文件计算</small>
          </div>
        </div>

        <p className="home-live-preview__image-note">
          打开完整工具后再选择文件，实际体积与压缩效果会由浏览器现场计算。
        </p>
      </div>

      <footer className="home-live-preview__footer">
        <p>输入内容不会离开当前页面。</p>
        <a
          href={toolHref(baseUrl, selectedTask.slug)}
          aria-label={`打开完整的${selectedTask.title}工具`}
        >
          打开完整工具 <span aria-hidden="true">→</span>
        </a>
      </footer>
    </section>
  );
}

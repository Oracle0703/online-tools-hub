import {
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
} from "react";

import type { ToolSummary } from "../lib/tool-registry";
import {
  detectSmartImage,
  detectSmartText,
  getUtf8ByteLength,
  MAX_SMART_IMAGE_BYTES,
  SMART_IMAGE_SIGNATURE_BYTES,
  type SmartImageDetection,
  type SmartTextDetection,
} from "../lib/smart-input-detection";

import "./SmartInputDetector.css";

type Props = {
  tools: ToolSummary[];
  baseUrl: string;
};

type Analysis =
  | SmartTextDetection
  | SmartImageDetection
  | {
      state: "analyzing";
      message: string;
      recommendations: [];
    };

function toolHref(baseUrl: string, slug: string): string {
  const normalizedBase = baseUrl.replace(/\/+$/u, "");
  return `${normalizedBase}/tools/${slug}/`;
}

function displayBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

export default function SmartInputDetector({ tools, baseUrl }: Props) {
  const componentId = useId();
  const textInputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const analysisRequestRef = useRef(0);
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState("");
  const [overrideAnalysis, setOverrideAnalysis] = useState<Analysis | null>(
    null,
  );
  const [isDragging, setIsDragging] = useState(false);

  const textAnalysis = useMemo(() => detectSmartText(text), [text]);
  const analysis = overrideAnalysis ?? textAnalysis;
  const textBytes = useMemo(() => getUtf8ByteLength(text), [text]);
  const toolBySlug = useMemo(
    () => new Map(tools.map((tool) => [tool.slug, tool])),
    [tools],
  );
  const recommendations = analysis.recommendations.slice(0, 3);
  const hasInput = Boolean(text || fileName || overrideAnalysis);
  const statusTone =
    analysis.state === "detected"
      ? "success"
      : analysis.state === "error" || analysis.state === "too-large"
        ? "error"
        : analysis.state === "analyzing"
          ? "working"
          : "idle";

  function updateText(nextText: string) {
    analysisRequestRef.current += 1;
    setFileName("");

    const nextAnalysis = detectSmartText(nextText);
    if (nextAnalysis.state === "too-large") {
      setText("");
      setOverrideAnalysis(nextAnalysis);
      return;
    }

    setText(nextText);
    setOverrideAnalysis(null);
  }

  async function analyzeImage(file: File) {
    const requestId = analysisRequestRef.current + 1;
    analysisRequestRef.current = requestId;
    setText("");
    setFileName(file.name || "未命名图片");

    if (file.size === 0 || file.size > MAX_SMART_IMAGE_BYTES) {
      setOverrideAnalysis(
        detectSmartImage({
          name: file.name,
          type: file.type,
          size: file.size,
          signature: new Uint8Array(),
        }),
      );
      return;
    }

    setOverrideAnalysis({
      state: "analyzing",
      message: `正在读取“${file.name || "未命名图片"}”的前 ${SMART_IMAGE_SIGNATURE_BYTES} 个签名字节…`,
      recommendations: [],
    });

    try {
      const signature = new Uint8Array(
        await file.slice(0, SMART_IMAGE_SIGNATURE_BYTES).arrayBuffer(),
      );
      if (analysisRequestRef.current !== requestId) return;

      setOverrideAnalysis(
        detectSmartImage({
          name: file.name,
          type: file.type,
          size: file.size,
          signature,
        }),
      );
    } catch {
      if (analysisRequestRef.current !== requestId) return;
      setOverrideAnalysis({
        state: "error",
        message: "无法读取文件签名字节，请重新选择一张图片。",
        recommendations: [],
      });
    }
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (file) void analyzeImage(file);
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setIsDragging(true);
  }

  function handleDragLeave(event: DragEvent<HTMLDivElement>) {
    if (
      event.relatedTarget instanceof Node &&
      event.currentTarget.contains(event.relatedTarget)
    ) {
      return;
    }
    setIsDragging(false);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDragging(false);

    const files = [...event.dataTransfer.files];
    if (files.length > 1) {
      analysisRequestRef.current += 1;
      setText("");
      setFileName("");
      setOverrideAnalysis({
        state: "error",
        message: "智能入口一次只识别一张图片，请重新选择。",
        recommendations: [],
      });
      return;
    }
    if (files[0]) {
      void analyzeImage(files[0]);
      return;
    }

    const droppedText = event.dataTransfer.getData("text/plain");
    if (droppedText) updateText(droppedText);
  }

  function clearInput() {
    analysisRequestRef.current += 1;
    setText("");
    setFileName("");
    setOverrideAnalysis(null);
    setIsDragging(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
    requestAnimationFrame(() => textInputRef.current?.focus());
  }

  return (
    <section
      className="smart-input"
      aria-labelledby={`${componentId}-title`}
      data-smart-input
    >
      <header className="smart-input__header">
        <div>
          <p className="eyebrow">智能入口</p>
          <h2 id={`${componentId}-title`}>粘贴内容，找到合适的工具</h2>
          <p>
            主动输入文本或拖入图片。格式识别完全在当前标签页完成，最多给出三个有依据的建议。
          </p>
        </div>
        <div className="smart-input__privacy" aria-label="隐私保护说明">
          <span aria-hidden="true">LOCAL</span>
          <strong>不读取剪贴板</strong>
          <small>不上传 · 不保存 · 不写入网址</small>
        </div>
      </header>

      <div className="smart-input__workspace">
        <div className="smart-input__input-panel">
          <div className="smart-input__field-heading">
            <label htmlFor={`${componentId}-input`}>粘贴或输入文本</label>
            <span aria-label={`当前文本 ${displayBytes(textBytes)}`}>
              {displayBytes(textBytes)} / 2 MiB
            </span>
          </div>
          <textarea
            ref={textInputRef}
            id={`${componentId}-input`}
            value={text}
            rows={7}
            spellCheck={false}
            autoComplete="off"
            placeholder={'例如：{"ready":true}、1710000000 或 https://…'}
            aria-describedby={`${componentId}-input-help ${componentId}-status`}
            aria-invalid={analysis.state === "too-large"}
            data-smart-input-text
            data-privacy-canary-input
            onChange={(event) => updateText(event.currentTarget.value)}
          />
          <p id={`${componentId}-input-help`} className="smart-input__help">
            只有你主动输入的内容才会被识别；本站不会调用剪贴板读取 API。
          </p>

          <div
            className={`smart-input__dropzone${isDragging ? " is-dragging" : ""}`}
            onDragEnter={handleDragOver}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
            <span className="smart-input__drop-mark" aria-hidden="true">
              IMG
            </span>
            <div>
              <strong>也可以拖入一张图片</strong>
              <p>
                JPEG、PNG 或 WebP，最大 20 MiB；只读取名称、MIME、大小和前 12
                字节。
              </p>
            </div>
            <label className="button button--secondary">
              选择图片
              <input
                ref={fileInputRef}
                id={`${componentId}-file`}
                className="visually-hidden"
                type="file"
                accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
                aria-describedby={`${componentId}-input-help`}
                onChange={handleFileChange}
              />
            </label>
          </div>
        </div>

        <div
          className="smart-input__result"
          aria-busy={analysis.state === "analyzing"}
        >
          <div className="smart-input__result-heading">
            <div>
              <span
                className={`smart-input__signal smart-input__signal--${statusTone}`}
              >
                <span aria-hidden="true" />
                {analysis.state === "detected"
                  ? "已识别"
                  : analysis.state === "analyzing"
                    ? "本地分析中"
                    : analysis.state === "error" ||
                        analysis.state === "too-large"
                      ? "无法识别"
                      : "等待识别"}
              </span>
              {analysis.state === "detected" ? (
                <h3>{analysis.label}</h3>
              ) : (
                <h3>从一段完整内容开始</h3>
              )}
            </div>
            {hasInput ? (
              <button
                className="button button--quiet smart-input__clear"
                type="button"
                onClick={clearInput}
              >
                清空
              </button>
            ) : null}
          </div>

          <p
            id={`${componentId}-status`}
            className={`smart-input__status smart-input__status--${statusTone}`}
            role={statusTone === "error" ? "alert" : "status"}
            aria-live={statusTone === "error" ? "assertive" : "polite"}
            aria-atomic="true"
          >
            {analysis.message}
          </p>

          {fileName ? (
            <p className="smart-input__file" title={fileName}>
              <span aria-hidden="true">FILE</span>
              {fileName}
            </p>
          ) : null}

          {recommendations.length > 0 ? (
            <div className="smart-input__recommendations">
              <p>推荐工具</p>
              <ol>
                {recommendations.map((recommendation) => {
                  const tool = toolBySlug.get(recommendation.slug);
                  const title = tool?.shortTitle ?? recommendation.slug;

                  return (
                    <li key={recommendation.slug}>
                      <a href={toolHref(baseUrl, recommendation.slug)}>
                        <span
                          className="smart-input__tool-mark"
                          aria-hidden="true"
                        >
                          {tool?.mark ?? "→"}
                        </span>
                        <span>
                          <strong>{title}</strong>
                          <small>{recommendation.reason}</small>
                        </span>
                        <span className="smart-input__arrow" aria-hidden="true">
                          →
                        </span>
                      </a>
                    </li>
                  );
                })}
              </ol>
              <p className="smart-input__handoff">
                点击只会打开工具，内容不会被自动带入；请在工具内再次粘贴。
              </p>
            </div>
          ) : (
            <div className="smart-input__examples" aria-label="支持识别的格式">
              <span>JSON</span>
              <span>JWT</span>
              <span>URL</span>
              <span>Base64</span>
              <span>时间戳</span>
              <span>CSV / TSV</span>
              <span>YAML</span>
              <span>图片</span>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

import { useId, useMemo, useState } from "react";

import {
  ToolWorkspace,
  ToolWorkspaceAction,
  ToolWorkspaceActions,
  ToolWorkspaceHeader,
  ToolWorkspaceRegion,
} from "../ToolWorkspace";
import { encodeBase64 } from "../../tools/base64-codec";
import {
  decodeJwt,
  MAX_JWT_BYTES,
  MAX_JWT_JSON_DEPTH,
  MAX_JWT_JSON_NODES,
  type DecodedJwt,
  type JwtTimeClaim,
} from "../../tools/jwt-decoder";

import "./JwtDecoderTool.css";

type Feedback = {
  kind: "idle" | "success" | "error";
  message: string;
  inputRelated?: boolean;
};

const idleFeedback: Feedback = {
  kind: "idle",
  message: "Token 只在当前标签页内解析，不会上传、验证签名或持久化。",
};

const sampleHeader = { alg: "HS256", typ: "JWT" };
const samplePayload = {
  sub: "online-tools-demo",
  name: "本地解析示例",
  iat: 1_767_225_600,
  nbf: 1_767_225_600,
  exp: 4_102_444_800,
};
const SAMPLE_TOKEN = `${encodeBase64(JSON.stringify(sampleHeader), "url")}.${encodeBase64(JSON.stringify(samplePayload), "url")}.${encodeBase64("demo-signature", "url")}`;

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function displayBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

function safeJsonStringify(value: unknown): string | null {
  try {
    const serialized = JSON.stringify(value, null, 2);
    return typeof serialized === "string" ? serialized : null;
  } catch {
    return null;
  }
}

function copyText(value: string): Promise<void> {
  if (!navigator.clipboard?.writeText) {
    return Promise.reject(new Error("Clipboard API unavailable"));
  }
  return navigator.clipboard.writeText(value);
}

function downloadText(value: string, filename: string): void {
  const url = URL.createObjectURL(
    new Blob([value], { type: "application/json;charset=utf-8" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  try {
    document.body.append(link);
    link.click();
  } finally {
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

function claimLabel(claim: JwtTimeClaim["claim"]): string {
  if (claim === "exp") return "过期时间 exp";
  if (claim === "nbf") return "生效时间 nbf";
  return "签发时间 iat";
}

function claimTone(claim: JwtTimeClaim): string {
  return [
    "expired",
    "pending",
    "future",
    "invalid-type",
    "invalid-date",
  ].includes(claim.state)
    ? "warning"
    : "ok";
}

export default function JwtDecoderTool() {
  const titleId = useId();
  const inputId = useId();
  const inputHelpId = useId();
  const feedbackId = useId();
  const [input, setInput] = useState("");
  const [decoded, setDecoded] = useState<DecodedJwt | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(idleFeedback);

  const inputBytes = useMemo(() => utf8Bytes(input), [input]);
  const isOverLimit = inputBytes > MAX_JWT_BYTES;
  const hasInputError =
    isOverLimit || (feedback.kind === "error" && feedback.inputRelated);
  const serializedParts = useMemo(
    () =>
      decoded
        ? {
            header: safeJsonStringify(decoded.header),
            payload: safeJsonStringify(decoded.payload),
          }
        : null,
    [decoded],
  );
  const serializationFailed =
    Boolean(decoded) &&
    (serializedParts?.header === null || serializedParts?.payload === null);
  const headerText = serializedParts?.header ?? "";
  const payloadText = serializedParts?.payload ?? "";

  function updateInput(value: string) {
    const bytes = utf8Bytes(value);
    setInput(value);
    setDecoded(null);
    setFeedback(
      bytes > MAX_JWT_BYTES
        ? {
            kind: "error",
            message: `输入为 ${displayBytes(bytes)}，超过 ${MAX_JWT_BYTES / 1024} KiB 上限。`,
            inputRelated: true,
          }
        : idleFeedback,
    );
  }

  function parseToken() {
    const result = decodeJwt(input);
    if (!result.ok) {
      setDecoded(null);
      setFeedback({
        kind: "error",
        message: result.error.message,
        inputRelated: true,
      });
      return;
    }

    setDecoded(result.value);
    setFeedback({
      kind: "success",
      message: result.value.isUnsigned
        ? "解析完成，但该 Token 未签名或声明 alg=none；不要把它当作可信身份。"
        : "解析完成。签名仅被保留，尚未使用密钥验证，内容不能视为可信。",
    });
  }

  function loadSample() {
    setInput(SAMPLE_TOKEN);
    setDecoded(null);
    setFeedback({
      kind: "idle",
      message: "已载入演示 Token；Signature 只是示例文本，不代表有效签名。",
    });
  }

  function clearAll() {
    setInput("");
    setDecoded(null);
    setFeedback(idleFeedback);
  }

  async function copyPart(value: string, label: string) {
    try {
      await copyText(value);
      setFeedback({ kind: "success", message: `${label}已复制到剪贴板。` });
    } catch {
      setFeedback({ kind: "error", message: "复制失败，请手动选择内容复制。" });
    }
  }

  function downloadDecoded() {
    if (!decoded) return;
    try {
      const downloadValue = safeJsonStringify({
        warning: "仅解析，未验证签名；不得据此信任令牌",
        header: decoded.header,
        payload: decoded.payload,
        signature: {
          present: decoded.signature.length > 0,
          verified: false,
        },
        timeClaims: decoded.timeClaims,
      });
      if (downloadValue === null) {
        setFeedback({
          kind: "error",
          message: "解析结果无法安全序列化，已停止下载。",
        });
        return;
      }

      downloadText(downloadValue, "decoded-jwt.json");
      setFeedback({ kind: "success", message: "已下载 decoded-jwt.json。" });
    } catch {
      setFeedback({ kind: "error", message: "下载失败，请稍后重试。" });
    }
  }

  return (
    <ToolWorkspace toolId="jwt-decoder" titleId={titleId} className="jwt-tool">
      <ToolWorkspaceHeader className="jwt-tool__heading">
        <div>
          <p className="eyebrow">JWT Inspector</p>
          <h2 id={titleId}>解析结构与时间声明</h2>
          <p>严格解码 Header、Payload 和常见 NumericDate 字段。</p>
        </div>
        <span className="soft-pill">仅解析 · 不验签</span>
      </ToolWorkspaceHeader>

      <aside className="jwt-tool__warning" aria-label="安全提示">
        <span aria-hidden="true">!</span>
        <p>
          <strong>解析不等于验签。</strong>
          任何人都能构造 Header 和
          Payload；只有使用可信密钥完成签名验证后，才能信任其中的身份与权限声明。
          JWT 和访问令牌通常属于敏感凭据，请优先使用脱敏样例。
        </p>
      </aside>

      <ToolWorkspaceRegion region="input" className="jwt-tool__input">
        <div className="jwt-tool__editor-head">
          <label htmlFor={inputId}>JWT Token</label>
          <span className={isOverLimit ? "is-over" : undefined}>
            {displayBytes(inputBytes)} / {MAX_JWT_BYTES / 1024} KiB
          </span>
        </div>
        <textarea
          id={inputId}
          className="jwt-tool__textarea"
          value={input}
          onChange={(event) => updateInput(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (
              (event.ctrlKey || event.metaKey) &&
              event.key === "Enter" &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              parseToken();
            }
          }}
          placeholder="粘贴 eyJ...eyJ...signature"
          aria-describedby={`${inputHelpId} ${feedbackId}`}
          aria-errormessage={hasInputError ? feedbackId : undefined}
          aria-invalid={hasInputError || undefined}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          wrap="off"
          data-privacy-canary-input
        />
        <p id={inputHelpId} className="jwt-tool__help">
          接受三段式 JWS/JWT 紧凑格式；不会请求密钥、调用远程接口或保存 Token。
          支持 <kbd>Ctrl</kbd>/<kbd>⌘</kbd> + <kbd>Enter</kbd> 快速解析。
          为避免静默改值，超安全整数和无法精确表示的小数会被拒绝，大编号请使用
          JSON 字符串；每段最多 {MAX_JWT_JSON_DEPTH} 层、
          {MAX_JWT_JSON_NODES.toLocaleString("en-US")} 个节点。
        </p>
      </ToolWorkspaceRegion>

      <ToolWorkspaceActions className="jwt-tool__actions">
        <ToolWorkspaceAction
          action="execute"
          className="button button--primary"
          type="button"
          disabled={!input.trim() || isOverLimit}
          onClick={parseToken}
          data-privacy-canary-action
        >
          解析 JWT
        </ToolWorkspaceAction>
        <ToolWorkspaceAction
          action="example"
          className="button button--secondary"
          type="button"
          onClick={loadSample}
        >
          载入示例
        </ToolWorkspaceAction>
        <ToolWorkspaceAction
          action="clear"
          className="button button--quiet"
          type="button"
          disabled={!input && !decoded}
          onClick={clearAll}
        >
          清空
        </ToolWorkspaceAction>
      </ToolWorkspaceActions>

      <div
        id={feedbackId}
        className={`jwt-tool__feedback jwt-tool__feedback--${feedback.kind}`}
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

      <ToolWorkspaceRegion
        region="output"
        className="jwt-tool__output"
        role="region"
        aria-label="JWT 解析结果"
      >
        {decoded && serializationFailed ? (
          <div className="jwt-tool__serialization-error" role="alert">
            <span aria-hidden="true">!</span>
            <div>
              <h3>结果无法安全显示</h3>
              <p>
                浏览器序列化解析结果时失败。为避免页面崩溃或输出错误数据，已停止显示、复制和下载。
              </p>
            </div>
          </div>
        ) : decoded ? (
          <>
            <aside
              className="jwt-tool__trust-banner"
              aria-label="解析结果可信度"
            >
              <strong>未验证签名</strong>
              <span>
                以下内容只代表成功解码，不代表令牌有效、可信或仍有权限。
              </span>
            </aside>

            <div className="jwt-tool__summary" aria-label="JWT 摘要">
              <div>
                <span>算法</span>
                <strong>{decoded.algorithm ?? "未声明"}</strong>
              </div>
              <div>
                <span>类型</span>
                <strong>{decoded.tokenType ?? "未声明"}</strong>
              </div>
              <div>
                <span>Signature</span>
                <strong>{decoded.signature ? "存在 · 未验证" : "空"}</strong>
              </div>
            </div>

            <div className="jwt-tool__decoded-grid">
              <section aria-labelledby={`${titleId}-header`}>
                <div className="jwt-tool__panel-head">
                  <h3 id={`${titleId}-header`}>Header</h3>
                  <button
                    type="button"
                    onClick={() => copyPart(headerText, "Header")}
                    aria-label="复制解码后的 JWT Header"
                  >
                    复制
                  </button>
                </div>
                <pre tabIndex={0} aria-label="解码后的 JWT Header">
                  {headerText}
                </pre>
              </section>
              <section aria-labelledby={`${titleId}-payload`}>
                <div className="jwt-tool__panel-head">
                  <h3 id={`${titleId}-payload`}>Payload</h3>
                  <button
                    type="button"
                    onClick={() => copyPart(payloadText, "Payload")}
                    aria-label="复制解码后的 JWT Payload"
                  >
                    复制
                  </button>
                </div>
                <pre tabIndex={0} aria-label="解码后的 JWT Payload">
                  {payloadText}
                </pre>
              </section>
            </div>

            <section
              className="jwt-tool__times"
              aria-labelledby={`${titleId}-times`}
            >
              <div className="jwt-tool__times-head">
                <div>
                  <p className="eyebrow">时间检查</p>
                  <h3 id={`${titleId}-times`}>常见 NumericDate 字段</h3>
                </div>
                <button type="button" onClick={downloadDecoded}>
                  下载解析结果
                </button>
              </div>
              {decoded.timeClaims.length ? (
                <ul>
                  {decoded.timeClaims.map((claim) => (
                    <li key={claim.claim}>
                      <div>
                        <strong>{claimLabel(claim.claim)}</strong>
                        <code>{claim.seconds ?? "非数值"}</code>
                      </div>
                      {claim.iso ? (
                        <time dateTime={claim.iso}>{claim.iso}</time>
                      ) : (
                        <span className="jwt-tool__claim-date">
                          无法表示为日期
                        </span>
                      )}
                      <span data-tone={claimTone(claim)}>{claim.message}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="jwt-tool__empty-time">
                  Payload 没有 exp、nbf 或 iat 字段。
                </p>
              )}
            </section>
          </>
        ) : (
          <div className="jwt-tool__empty">
            <span aria-hidden="true">JWT</span>
            <div>
              <h3>等待解析</h3>
              <p>解析后将在这里显示结构、算法声明和时间状态。</p>
            </div>
          </div>
        )}
      </ToolWorkspaceRegion>
    </ToolWorkspace>
  );
}

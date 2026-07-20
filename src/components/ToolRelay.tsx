import { useId, useState } from "react";

import { relayToolOutput } from "../lib/tool-relay";

import "./ToolRelay.css";

const SUCCESS_ANNOUNCEMENT_DELAY_MS = 700;

interface ToolRelayProps {
  value: string;
  targetSlug: string;
  targetLabel: string;
  sourceLabel?: string;
}

type RelayStatus =
  | { kind: "idle"; message: string }
  | { kind: "copying"; message: string }
  | { kind: "success"; message: string }
  | { kind: "error"; message: string };

export default function ToolRelay({
  value,
  targetSlug,
  targetLabel,
  sourceLabel = "当前结果",
}: ToolRelayProps) {
  const helpId = useId();
  const statusId = useId();
  const [status, setStatus] = useState<RelayStatus>({
    kind: "idle",
    message: "等待接力操作。",
  });

  async function startRelay() {
    if (!value || status.kind === "copying") return;

    setStatus({ kind: "copying", message: "正在复制…" });
    const result = await relayToolOutput({
      value,
      baseUrl: import.meta.env.BASE_URL,
      targetSlug,
      writeText: navigator.clipboard?.writeText
        ? (text) => navigator.clipboard.writeText(text)
        : undefined,
      onCopied: () =>
        setStatus({
          kind: "success",
          message: "已复制，正在打开目标工具；到达后请手动粘贴。",
        }),
      navigate: (href) => {
        window.setTimeout(() => {
          try {
            window.location.assign(href);
          } catch {
            setStatus({
              kind: "error",
              message: "内容已复制，但无法打开目标工具；请手动打开后粘贴。",
            });
          }
        }, SUCCESS_ANNOUNCEMENT_DELAY_MS);
      },
    });

    if (!result.ok) {
      setStatus({ kind: "error", message: result.message });
    }
  }

  return (
    <aside className="tool-relay" aria-labelledby={`${helpId}-title`}>
      <div className="tool-relay__copy">
        <span className="tool-relay__mark" aria-hidden="true">
          →
        </span>
        <div>
          <p className="tool-relay__eyebrow">继续处理</p>
          <h3 id={`${helpId}-title`}>
            {sourceLabel} → {targetLabel}
          </h3>
          <p id={helpId} className="tool-relay__help">
            点击后才会复制并打开；到达后请手动粘贴。目标工具不会自动读取剪贴板，内容也不会写入网址或浏览器存储。
          </p>
        </div>
      </div>
      <button
        type="button"
        className="button button--secondary tool-relay__action"
        onClick={startRelay}
        disabled={
          !value || status.kind === "copying" || status.kind === "success"
        }
        aria-describedby={`${helpId} ${statusId}`}
        data-tool-relay={targetSlug}
      >
        {status.kind === "copying"
          ? "正在复制…"
          : status.kind === "success"
            ? "已复制，正在打开…"
            : `复制并打开 ${targetLabel}`}
      </button>
      <p
        id={statusId}
        className={`tool-relay__status tool-relay__status--${status.kind}${status.kind === "idle" ? " sr-only" : ""}`}
        role={
          status.kind === "idle"
            ? undefined
            : status.kind === "error"
              ? "alert"
              : "status"
        }
        aria-live={
          status.kind === "idle"
            ? undefined
            : status.kind === "error"
              ? "assertive"
              : "polite"
        }
        aria-atomic={status.kind === "idle" ? undefined : "true"}
      >
        {status.message}
      </p>
    </aside>
  );
}

const TOOL_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export type ToolRelayFailure =
  | "empty-output"
  | "invalid-target"
  | "clipboard-unavailable"
  | "clipboard-write-failed"
  | "navigation-failed";

export type ToolRelayResult =
  | { ok: true; href: string }
  | { ok: false; reason: ToolRelayFailure; message: string };

interface RelayToolOutputOptions {
  value: string;
  baseUrl: string;
  targetSlug: string;
  writeText?: (value: string) => Promise<void>;
  onCopied?: () => void;
  navigate: (href: string) => void;
}

/**
 * Builds a static, same-site tool path. Tool output is deliberately not part of
 * the URL so a relay cannot leak content into history, logs, or referrers.
 */
export function buildToolRelayHref(
  baseUrl: string,
  targetSlug: string,
): string | null {
  if (!TOOL_SLUG_PATTERN.test(targetSlug)) return null;

  const basePath = (baseUrl.split(/[?#]/u, 1)[0] ?? "/")
    .replace(/^\/+|\/+$/gu, "")
    .trim();
  const prefix = basePath ? `/${basePath}` : "";

  return `${prefix}/tools/${targetSlug}/`;
}

/**
 * Copies output only after an explicit caller action, then opens a static tool
 * route. This function never reads the clipboard or touches browser storage.
 */
export async function relayToolOutput({
  value,
  baseUrl,
  targetSlug,
  writeText,
  onCopied,
  navigate,
}: RelayToolOutputOptions): Promise<ToolRelayResult> {
  if (!value) {
    return {
      ok: false,
      reason: "empty-output",
      message: "没有可接力的输出，请先完成当前处理。",
    };
  }

  const href = buildToolRelayHref(baseUrl, targetSlug);
  if (!href) {
    return {
      ok: false,
      reason: "invalid-target",
      message: "目标工具地址无效，已停止接力。",
    };
  }

  if (!writeText) {
    return {
      ok: false,
      reason: "clipboard-unavailable",
      message: "当前浏览器不支持安全复制，未打开目标工具。请手动复制。",
    };
  }

  try {
    await writeText(value);
  } catch {
    return {
      ok: false,
      reason: "clipboard-write-failed",
      message: "复制失败，未打开目标工具。请允许剪贴板权限或手动复制。",
    };
  }

  onCopied?.();

  try {
    navigate(href);
  } catch {
    return {
      ok: false,
      reason: "navigation-failed",
      message: "内容已复制，但无法打开目标工具；请手动打开后粘贴。",
    };
  }

  return { ok: true, href };
}

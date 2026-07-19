export type PrivacyMode = "local" | "network";
export type ToolStatus = "planned" | "available";

export type CategoryDefinition = {
  id: string;
  slug: string;
  title: string;
  description: string;
  mark: string;
};

export type ToolDefinition = {
  id: string;
  slug: string;
  category: CategoryDefinition["slug"];
  title: string;
  shortTitle: string;
  description: string;
  keywords: string[];
  privacyMode: PrivacyMode;
  status: ToolStatus;
  featured: boolean;
  enabled: boolean;
  mark: string;
  limits: {
    maxTextBytes?: number;
    maxFileBytes?: number;
  };
  load: () => Promise<{ default: unknown }>;
};

export type ToolSummary = Omit<ToolDefinition, "load">;

export const DEFAULT_MAX_TEXT_BYTES = 2 * 1024 * 1024;

export const categories: CategoryDefinition[] = [
  {
    id: "format-validation",
    slug: "format-validation",
    title: "格式化与校验",
    description: "整理结构化数据，快速发现语法和格式问题。",
    mark: "{ }",
  },
  {
    id: "encode-decode",
    slug: "encode-decode",
    title: "编码与解码",
    description: "在常见文本和网络编码之间可靠转换。",
    mark: "↔",
  },
  {
    id: "time-identifiers",
    slug: "time-identifiers",
    title: "时间与标识符",
    description: "处理时间表示，并生成安全的唯一标识符。",
    mark: "#",
  },
  {
    id: "text-processing",
    slug: "text-processing",
    title: "文本处理",
    description: "比较、清理和转换文本的后续工具集合。",
    mark: "Aa",
  },
  {
    id: "security-hash",
    slug: "security-hash",
    title: "安全与哈希",
    description: "面向校验与开发场景的本地哈希工具。",
    mark: "◇",
  },
];

const comingSoon = () => import("../components/ComingSoonTool");

export const tools: ToolDefinition[] = [
  {
    id: "json-formatter",
    slug: "json-formatter",
    category: "format-validation",
    title: "JSON 格式化与校验",
    shortTitle: "JSON 格式化",
    description: "格式化、压缩并检查 JSON 语法，错误信息将精确指向问题位置。",
    keywords: ["json", "格式化", "压缩", "校验", "formatter", "validator"],
    privacyMode: "local",
    status: "planned",
    featured: true,
    enabled: true,
    mark: "{ }",
    limits: { maxTextBytes: DEFAULT_MAX_TEXT_BYTES },
    load: comingSoon,
  },
  {
    id: "base64-codec",
    slug: "base64-codec",
    category: "encode-decode",
    title: "Base64 编码与解码",
    shortTitle: "Base64 编解码",
    description:
      "正确处理 UTF-8、中文和 Emoji，并支持标准 Base64 与 Base64URL。",
    keywords: ["base64", "编码", "解码", "utf-8", "base64url"],
    privacyMode: "local",
    status: "planned",
    featured: true,
    enabled: true,
    mark: "B64",
    limits: { maxTextBytes: DEFAULT_MAX_TEXT_BYTES },
    load: comingSoon,
  },
  {
    id: "url-codec",
    slug: "url-codec",
    category: "encode-decode",
    title: "URL 编码与解码",
    shortTitle: "URL 编解码",
    description: "区分 URL 组件与完整 URL，安全地编码或还原特殊字符。",
    keywords: ["url", "uri", "百分号", "encode", "decode", "链接"],
    privacyMode: "local",
    status: "planned",
    featured: true,
    enabled: true,
    mark: "%",
    limits: { maxTextBytes: DEFAULT_MAX_TEXT_BYTES },
    load: comingSoon,
  },
  {
    id: "unix-timestamp",
    slug: "unix-timestamp",
    category: "time-identifiers",
    title: "Unix 时间戳转换",
    shortTitle: "时间戳转换",
    description: "在秒、毫秒、本地时间、UTC 和 ISO 8601 之间转换。",
    keywords: ["unix", "时间戳", "timestamp", "utc", "iso", "日期"],
    privacyMode: "local",
    status: "planned",
    featured: true,
    enabled: true,
    mark: "T",
    limits: { maxTextBytes: 4 * 1024 },
    load: comingSoon,
  },
  {
    id: "uuid-generator",
    slug: "uuid-generator",
    category: "time-identifiers",
    title: "UUID v4 生成器",
    shortTitle: "UUID 生成器",
    description: "使用浏览器的密码学安全随机源，单个或批量生成 UUID v4。",
    keywords: ["uuid", "guid", "v4", "随机", "生成器", "identifier"],
    privacyMode: "local",
    status: "planned",
    featured: true,
    enabled: true,
    mark: "ID",
    limits: {},
    load: comingSoon,
  },
];

export const enabledTools = tools.filter((tool) => tool.enabled);

export function getToolBySlug(slug: string): ToolDefinition | undefined {
  return enabledTools.find((tool) => tool.slug === slug);
}

export function getCategoryBySlug(
  slug: string,
): CategoryDefinition | undefined {
  return categories.find((category) => category.slug === slug);
}

export function getToolsByCategory(categorySlug: string): ToolDefinition[] {
  return enabledTools.filter((tool) => tool.category === categorySlug);
}

export function toToolSummary(tool: ToolDefinition): ToolSummary {
  const summary = { ...tool };
  delete (summary as Partial<ToolDefinition>).load;

  return summary;
}

export function pathFor(path = "/"): string {
  const base = import.meta.env.BASE_URL.replace(/\/$/, "");
  const normalized = path.replace(/^\/+|\/+$/g, "");

  if (!normalized) return `${base}/`;

  const isFile = /\/[A-Za-z0-9_-]+\.[A-Za-z0-9]+$/.test(`/${normalized}`);

  return `${base}/${normalized}${isFile ? "" : "/"}`;
}

export function bytesToDisplay(bytes?: number): string | undefined {
  if (bytes === undefined) return undefined;
  if (bytes >= 1024 * 1024) return `${bytes / (1024 * 1024)} MiB`;
  if (bytes >= 1024) return `${bytes / 1024} KiB`;
  return `${bytes} B`;
}

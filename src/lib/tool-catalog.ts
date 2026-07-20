export type PrivacyMode = "local" | "network";
export type ToolStatus = "planned" | "available";
export type ToolCapability =
  | "input"
  | "output"
  | "execute"
  | "copy"
  | "download"
  | "swap"
  | "example"
  | "clear";

export type CategoryDefinition = {
  id: string;
  slug: string;
  title: string;
  description: string;
  mark: string;
};

export const toolSlugs = [
  "json-formatter",
  "base64-codec",
  "url-codec",
  "unix-timestamp",
  "uuid-generator",
  "image-compressor",
  "text-diff",
  "hash-generator",
  "yaml-json-converter",
  "jwt-decoder",
  "csv-json-converter",
  "query-params",
] as const;

export type ToolSlug = (typeof toolSlugs)[number];

type ToolDefinitionBase = {
  id: string;
  slug: string;
  category: CategoryDefinition["slug"];
  title: string;
  shortTitle: string;
  description: string;
  keywords: string[];
  status: ToolStatus;
  featured: boolean;
  enabled: boolean;
  mark: string;
  limits: {
    maxTextBytes?: number;
    maxFileBytes?: number;
  };
  capabilities: readonly ToolCapability[];
};

export type ToolDefinition = ToolDefinitionBase &
  (
    | {
        privacyMode: "local";
        network?: never;
      }
    | {
        privacyMode: "network";
        network: {
          providerName: string;
          providerUrl: string;
          sentFields: string[];
          purpose: string;
          trigger: string;
        };
      }
  );

/**
 * Lightweight, serializable metadata safe to import from any static page or
 * client island. Runtime UI loaders live in `tool-runtime.ts` so importing the
 * catalog never pulls tool components or their CSS into unrelated pages.
 */
export type ToolSummary = ToolDefinition;

export const DEFAULT_MAX_TEXT_BYTES = 2 * 1024 * 1024;

export const categories: CategoryDefinition[] = [
  {
    id: "format-validation",
    slug: "format-validation",
    title: "格式化与校验",
    description:
      "整理结构化数据，快速发现语法和格式问题，并输出便于阅读的结果。",
    mark: "{ }",
  },
  {
    id: "encode-decode",
    slug: "encode-decode",
    title: "编码与解码",
    description:
      "在常见文本和网络编码之间可靠转换，明确处理 Unicode 与异常输入。",
    mark: "↔",
  },
  {
    id: "time-identifiers",
    slug: "time-identifiers",
    title: "时间与标识符",
    description:
      "处理时间表示，并生成安全的唯一标识符，覆盖常见边界与批量场景。",
    mark: "#",
  },
  {
    id: "files-images",
    slug: "files-images",
    title: "文件与图片",
    description:
      "在浏览器本地压缩、转换和导出图片文件，明确格式、质量与大小边界。",
    mark: "IMG",
  },
  {
    id: "text-processing",
    slug: "text-processing",
    title: "文本处理",
    description: "逐行比较、清理和转换文本，清楚标出内容差异。",
    mark: "Aa",
  },
  {
    id: "security-hash",
    slug: "security-hash",
    title: "安全与哈希",
    description: "在本地检查令牌内容、生成摘要并核对数据完整性。",
    mark: "◇",
  },
];

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
    status: "available",
    featured: true,
    enabled: true,
    mark: "{ }",
    limits: { maxTextBytes: DEFAULT_MAX_TEXT_BYTES },
    capabilities: [
      "input",
      "output",
      "execute",
      "copy",
      "download",
      "example",
      "clear",
    ],
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
    status: "available",
    featured: true,
    enabled: true,
    mark: "B64",
    limits: { maxTextBytes: DEFAULT_MAX_TEXT_BYTES },
    capabilities: [
      "input",
      "output",
      "execute",
      "copy",
      "download",
      "swap",
      "example",
      "clear",
    ],
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
    status: "available",
    featured: true,
    enabled: true,
    mark: "%",
    limits: { maxTextBytes: DEFAULT_MAX_TEXT_BYTES },
    capabilities: [
      "input",
      "output",
      "execute",
      "copy",
      "swap",
      "example",
      "clear",
    ],
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
    status: "available",
    featured: true,
    enabled: true,
    mark: "T",
    limits: { maxTextBytes: 4 * 1024 },
    capabilities: ["input", "output", "execute", "copy", "example", "clear"],
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
    status: "available",
    featured: true,
    enabled: true,
    mark: "ID",
    limits: {},
    capabilities: ["input", "output", "execute", "copy", "download", "clear"],
  },
  {
    id: "image-compressor",
    slug: "image-compressor",
    category: "files-images",
    title: "图片压缩与格式转换",
    shortTitle: "图片压缩",
    description:
      "在浏览器本地批量压缩 JPEG、PNG 和 WebP，可调整质量、尺寸与输出格式。",
    keywords: [
      "图片压缩",
      "PNG 压缩",
      "JPEG 压缩",
      "JPG 压缩",
      "WebP 压缩",
      "格式转换",
      "image compressor",
    ],
    privacyMode: "local",
    status: "available",
    featured: true,
    enabled: true,
    mark: "IMG",
    limits: { maxFileBytes: 20 * 1024 * 1024 },
    capabilities: ["input", "output", "execute", "download", "clear"],
  },
  {
    id: "text-diff",
    slug: "text-diff",
    category: "text-processing",
    title: "文本差异对比",
    shortTitle: "文本差异",
    description: "逐行比较两段文本，以并排和统一视图清楚标出新增、删除与修改。",
    keywords: ["文本对比", "diff", "差异", "逐行比较", "代码对比"],
    privacyMode: "local",
    status: "available",
    featured: true,
    enabled: true,
    mark: "DIFF",
    limits: { maxTextBytes: 512 * 1024 },
    capabilities: [
      "input",
      "output",
      "execute",
      "copy",
      "download",
      "swap",
      "example",
      "clear",
    ],
  },
  {
    id: "hash-generator",
    slug: "hash-generator",
    category: "security-hash",
    title: "SHA 哈希生成与校验",
    shortTitle: "SHA 哈希",
    description:
      "使用浏览器 Web Crypto 为文本或文件生成 SHA-256、SHA-512 摘要并核对哈希值。",
    keywords: ["sha-256", "sha-512", "hash", "哈希", "文件校验", "checksum"],
    privacyMode: "local",
    status: "available",
    featured: true,
    enabled: true,
    mark: "SHA",
    limits: {
      maxTextBytes: DEFAULT_MAX_TEXT_BYTES,
      maxFileBytes: 20 * 1024 * 1024,
    },
    capabilities: [
      "input",
      "output",
      "execute",
      "copy",
      "download",
      "example",
      "clear",
    ],
  },
  {
    id: "yaml-json-converter",
    slug: "yaml-json-converter",
    category: "format-validation",
    title: "YAML 与 JSON 互转",
    shortTitle: "YAML / JSON",
    description:
      "在 YAML 1.2 与 JSON 之间转换，严格提示语法、重复键和不兼容值。",
    keywords: ["yaml", "yml", "json", "转换", "格式化", "校验"],
    privacyMode: "local",
    status: "available",
    featured: true,
    enabled: true,
    mark: "YML",
    limits: { maxTextBytes: DEFAULT_MAX_TEXT_BYTES },
    capabilities: [
      "input",
      "output",
      "execute",
      "copy",
      "download",
      "swap",
      "example",
      "clear",
    ],
  },
  {
    id: "jwt-decoder",
    slug: "jwt-decoder",
    category: "security-hash",
    title: "JWT 解码与声明检查",
    shortTitle: "JWT 解码",
    description:
      "在浏览器本地解码 JWT Header 与 Payload，并清楚标示时间声明和未验签边界。",
    keywords: ["jwt", "json web token", "token", "解码", "exp", "payload"],
    privacyMode: "local",
    status: "available",
    featured: true,
    enabled: true,
    mark: "JWT",
    limits: { maxTextBytes: 256 * 1024 },
    capabilities: [
      "input",
      "output",
      "execute",
      "copy",
      "download",
      "example",
      "clear",
    ],
  },
  {
    id: "csv-json-converter",
    slug: "csv-json-converter",
    category: "format-validation",
    title: "CSV 与 JSON 互转",
    shortTitle: "CSV / JSON",
    description:
      "在 CSV、TSV 与 JSON 数组之间严格转换，保留字符串、引号换行和列结构。",
    keywords: [
      "csv 转 json",
      "json 转 csv",
      "tsv",
      "表格转换",
      "delimiter",
      "数据转换",
    ],
    privacyMode: "local",
    status: "available",
    featured: true,
    enabled: true,
    mark: "CSV",
    limits: { maxTextBytes: DEFAULT_MAX_TEXT_BYTES },
    capabilities: [
      "input",
      "output",
      "execute",
      "copy",
      "download",
      "swap",
      "example",
      "clear",
    ],
  },
  {
    id: "query-params",
    slug: "query-params",
    category: "encode-decode",
    title: "URL 查询参数解析与构建",
    shortTitle: "查询参数",
    description:
      "解析、编辑并重建 URL 查询参数，保留重复键、顺序、空值与无等号语义。",
    keywords: [
      "url 参数",
      "query string",
      "查询参数",
      "urlsearchparams",
      "百分号编码",
      "链接构建",
    ],
    privacyMode: "local",
    status: "available",
    featured: true,
    enabled: true,
    mark: "?=",
    limits: { maxTextBytes: DEFAULT_MAX_TEXT_BYTES },
    capabilities: [
      "input",
      "output",
      "execute",
      "copy",
      "download",
      "example",
      "clear",
    ],
  },
];

export const enabledTools = tools.filter((tool) => tool.enabled);

export function hasCompleteNetworkDisclosure(tool: {
  privacyMode: PrivacyMode;
  network?: Partial<{
    providerName: string;
    providerUrl: string;
    sentFields: string[];
    purpose: string;
    trigger: string;
  }>;
}): boolean {
  if (tool.privacyMode === "local") return true;

  return Boolean(
    tool.network?.providerName?.trim() &&
    tool.network.providerUrl?.trim() &&
    tool.network.sentFields?.length &&
    tool.network.sentFields.every((field) => field.trim().length > 0) &&
    tool.network.purpose?.trim() &&
    tool.network.trigger?.trim(),
  );
}

export function getToolStaticPaths() {
  return enabledTools.map((tool) => ({
    params: { slug: tool.slug },
    props: { tool },
  }));
}

export function getCategoryStaticPaths() {
  return categories.map((category) => ({
    params: { slug: category.slug },
    props: { category },
  }));
}

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
  return { ...tool };
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

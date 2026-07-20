import {
  detectImageFormat,
  MAX_IMAGE_FILE_BYTES,
  validateImageQueue,
  type SupportedImageFormat,
} from "../tools/image-compressor";

export const MAX_SMART_INPUT_BYTES = 2 * 1024 * 1024;
export const SMART_IMAGE_SIGNATURE_BYTES = 12;
export const MAX_SMART_IMAGE_BYTES = MAX_IMAGE_FILE_BYTES;

export type SmartInputKind =
  | "json"
  | "jwt"
  | "url"
  | "query"
  | "base64"
  | "timestamp"
  | "csv"
  | "tsv"
  | "yaml"
  | "image";

export type SmartToolRecommendation = {
  slug: string;
  reason: string;
};

export type SmartTextDetection =
  | {
      state: "empty";
      message: string;
      recommendations: [];
    }
  | {
      state: "too-large";
      message: string;
      byteLength: number;
      recommendations: [];
    }
  | {
      state: "unknown";
      message: string;
      byteLength: number;
      recommendations: [];
    }
  | {
      state: "detected";
      kind: Exclude<SmartInputKind, "image">;
      label: string;
      message: string;
      byteLength: number;
      recommendations: SmartToolRecommendation[];
    };

export type SmartImageInput = {
  name: string;
  type: string;
  size: number;
  signature: Uint8Array;
};

export type SmartImageDetection =
  | {
      state: "error";
      message: string;
      recommendations: [];
    }
  | {
      state: "detected";
      kind: "image";
      label: string;
      message: string;
      format: SupportedImageFormat;
      recommendations: SmartToolRecommendation[];
    };

type DetectedText = Omit<
  Extract<SmartTextDetection, { state: "detected" }>,
  "byteLength" | "state"
>;

const FORMAT_LABELS: Readonly<Record<SupportedImageFormat, string>> = {
  jpeg: "JPEG 图片",
  png: "PNG 图片",
  webp: "WebP 图片",
};

const FORMAT_MIME_TYPES: Readonly<Record<SupportedImageFormat, string>> = {
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

const textDecoder = new TextDecoder("utf-8", { fatal: true });

export function getUtf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function detectSmartText(input: string): SmartTextDetection {
  const byteLength = getUtf8ByteLength(input);

  if (byteLength > MAX_SMART_INPUT_BYTES) {
    return {
      state: "too-large",
      byteLength,
      message: `文本为 ${formatBytes(byteLength)}，超过 2 MiB 识别上限，已拒绝且不会保留。`,
      recommendations: [],
    };
  }

  const value = input.replace(/^\uFEFF/u, "").trim();
  if (!value) {
    return {
      state: "empty",
      message: "主动粘贴一段文本，或选择一张图片；我们不会读取你的剪贴板。",
      recommendations: [],
    };
  }

  const parsedJson = detectJson(value);
  const structuredJson =
    value.startsWith("{") || value.startsWith("[") ? parsedJson : null;
  const detected =
    detectJwt(value) ??
    structuredJson ??
    detectUrl(value) ??
    detectTimestamp(value) ??
    parsedJson ??
    detectYaml(value) ??
    detectDelimitedText(value) ??
    detectBase64(value);

  if (!detected) {
    return {
      state: "unknown",
      byteLength,
      message: "暂时无法可靠判断格式。可以换一段完整内容，或浏览下方工具目录。",
      recommendations: [],
    };
  }

  return { state: "detected", byteLength, ...detected };
}

export function detectSmartImage(input: SmartImageInput): SmartImageDetection {
  const queueResult = validateImageQueue([
    { name: input.name, size: input.size },
  ]);
  if (!queueResult.ok) {
    return {
      state: "error",
      message: queueResult.error.message,
      recommendations: [],
    };
  }

  const format = detectImageFormat(
    input.signature.subarray(0, SMART_IMAGE_SIGNATURE_BYTES),
  );
  if (!format) {
    return {
      state: "error",
      message: "签名字节不是受支持的 JPEG、PNG 或 WebP 图片。",
      recommendations: [],
    };
  }

  const expectedMime = FORMAT_MIME_TYPES[format];
  const declaredMime = input.type.trim().toLowerCase();
  const mimeNote =
    declaredMime && declaredMime !== expectedMime
      ? `文件声明为 ${declaredMime}，但签名字节确认为 ${expectedMime}；将以签名为准。`
      : `已通过文件签名字节确认格式；未解码图片内容。`;

  return {
    state: "detected",
    kind: "image",
    label: FORMAT_LABELS[format],
    format,
    message: `${FORMAT_LABELS[format]}：${mimeNote} 大小 ${formatBytes(input.size)}。`,
    recommendations: [
      {
        slug: "image-compressor",
        reason: "压缩体积、调整尺寸，或在 JPEG、PNG、WebP 之间转换。",
      },
      {
        slug: "hash-generator",
        reason: "为原文件计算 SHA 摘要，便于校验完整性。",
      },
    ],
  };
}

function detectJwt(value: string): DetectedText | null {
  const segments = value.split(".");
  if (
    segments.length !== 3 ||
    segments.some((segment) => !segment || !/^[A-Za-z0-9_-]+$/u.test(segment))
  ) {
    return null;
  }

  const header = decodeBase64UrlJson(segments[0]!);
  const payload = decodeBase64UrlJson(segments[1]!);
  if (!isPlainRecord(header) || !isPlainRecord(payload)) return null;

  return {
    kind: "jwt",
    label: "JWT 令牌",
    message: "检测到三段式 JWT；这里只识别结构，不验证签名或有效性。",
    recommendations: [
      {
        slug: "jwt-decoder",
        reason: "本地查看 Header、Payload 与 exp、nbf 等时间声明。",
      },
      {
        slug: "base64-codec",
        reason: "单独检查 Base64URL 分段的编码内容。",
      },
      {
        slug: "json-formatter",
        reason: "整理已解码的 Header 或 Payload JSON。",
      },
    ],
  };
}

function detectUrl(value: string): DetectedText | null {
  if (!/[\r\n]/u.test(value)) {
    try {
      const url = new URL(value);
      if (/^(?:https?|ftp):$/u.test(url.protocol)) {
        const hasQuery = url.search.length > 1;
        return {
          kind: "url",
          label: hasQuery ? "带查询参数的完整 URL" : "完整 URL",
          message: hasQuery
            ? "检测到完整链接和查询字符串，可以拆解参数或处理编码。"
            : "检测到完整链接，可以安全处理其中的特殊字符。",
          recommendations: hasQuery
            ? [
                {
                  slug: "query-params",
                  reason: "逐项查看、编辑并重建查询参数。",
                },
                {
                  slug: "url-codec",
                  reason: "编码或解码链接中的特殊字符。",
                },
              ]
            : [
                {
                  slug: "url-codec",
                  reason: "区分完整 URL 与组件，安全执行编码或解码。",
                },
              ],
        };
      }
    } catch {
      // Continue with query-string detection.
    }
  }

  if (looksLikeQueryString(value)) {
    return {
      kind: "query",
      label: "URL 查询参数",
      message: "检测到查询字符串，可以保留重复键、空值和参数顺序。",
      recommendations: [
        {
          slug: "query-params",
          reason: "解析为可编辑参数列表，再重建查询字符串。",
        },
        {
          slug: "url-codec",
          reason: "处理参数值中的百分号编码与特殊字符。",
        },
      ],
    };
  }

  return null;
}

function detectTimestamp(value: string): DetectedText | null {
  if (!/^-?(?:\d{10}|\d{13})$/u.test(value)) return null;

  const numeric = Number(value);
  const milliseconds =
    value.replace(/^-/, "").length === 10 ? numeric * 1000 : numeric;
  const date = new Date(milliseconds);
  if (!Number.isFinite(milliseconds) || Number.isNaN(date.getTime())) {
    return null;
  }

  const year = date.getUTCFullYear();
  if (year < 1970 || year > 2200) return null;

  return {
    kind: "timestamp",
    label:
      value.replace(/^-/, "").length === 10
        ? "Unix 秒级时间戳"
        : "Unix 毫秒级时间戳",
    message: `检测到可转换的 Unix 时间戳，对应年份为 ${year}。`,
    recommendations: [
      {
        slug: "unix-timestamp",
        reason: "转换为本地时间、UTC 和 ISO 8601，并核对秒/毫秒单位。",
      },
    ],
  };
}

function detectJson(value: string): DetectedText | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return null;
  }

  const recommendations: SmartToolRecommendation[] = [
    {
      slug: "json-formatter",
      reason: "格式化结构并检查 JSON 语法。",
    },
    {
      slug: "yaml-json-converter",
      reason: "需要配置文件格式时，可将 JSON 转为 YAML。",
    },
  ];

  if (
    Array.isArray(parsed) &&
    parsed.length > 0 &&
    parsed.every((item) => isPlainRecord(item))
  ) {
    recommendations.push({
      slug: "csv-json-converter",
      reason: "对象数组还可以转换为 CSV 表格。",
    });
  }

  return {
    kind: "json",
    label: "JSON 数据",
    message: "检测到有效 JSON；识别过程没有修改或保存内容。",
    recommendations,
  };
}

function detectYaml(value: string): DetectedText | null {
  const lines = value
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() && !/^\s*#/u.test(line));
  if (lines.length < 2) return null;

  const mappingLines = lines.filter((line) =>
    /^\s*(?:[A-Za-z_][\w.-]*|["'][^"']+["'])\s*:\s*(?:.*)$/u.test(line),
  ).length;
  const listLines = lines.filter((line) => /^\s*-\s+\S/u.test(line)).length;
  const hasDocumentMarker = lines[0]?.trim() === "---";
  const hasYamlShape =
    mappingLines >= 2 ||
    (mappingLines >= 1 && listLines >= 1) ||
    (hasDocumentMarker && mappingLines >= 1);

  if (!hasYamlShape) return null;

  return {
    kind: "yaml",
    label: "YAML 文档",
    message: "检测到 YAML 常见的键值或列表结构；完整语法将在工具中校验。",
    recommendations: [
      {
        slug: "yaml-json-converter",
        reason: "严格校验 YAML 1.2，并转换为 JSON。",
      },
    ],
  };
}

function detectDelimitedText(value: string): DetectedText | null {
  const tsv = inspectDelimitedShape(value, "\t");
  const csv = inspectDelimitedShape(value, ",");
  const detected = tsv ?? csv;
  if (!detected) return null;

  const kind = detected.delimiter === "\t" ? "tsv" : "csv";
  const label = kind === "tsv" ? "TSV 表格数据" : "CSV 表格数据";

  return {
    kind,
    label,
    message: `检测到约 ${detected.rows} 行、${detected.columns} 列的${kind.toUpperCase()} 数据。`,
    recommendations: [
      {
        slug: "csv-json-converter",
        reason: `解析${kind.toUpperCase()} 表格并转换为 JSON 对象数组。`,
      },
    ],
  };
}

function detectBase64(value: string): DetectedText | null {
  const compact = value.replace(/\s+/gu, "");
  if (
    compact.length < 8 ||
    compact.length % 4 === 1 ||
    !/^[A-Za-z0-9+/_-]*={0,2}$/u.test(compact) ||
    /=/.test(compact.slice(0, -2))
  ) {
    return null;
  }

  const isUrlVariant = /[-_]/u.test(compact) && !/[+/]/u.test(compact);
  const decoded = decodeBase64Bytes(compact);
  if (!decoded || decoded.length === 0) return null;

  const readable = isDecodedBase64Readable(decoded);

  const hasStrongEncodingSignal = /[=+/_-]/u.test(compact);
  if (!readable && !hasStrongEncodingSignal) return null;

  return {
    kind: "base64",
    label: isUrlVariant ? "Base64URL 数据" : "Base64 数据",
    message: isUrlVariant
      ? "检测到 Base64URL 字符集；工具会在本地尝试解码。"
      : "检测到符合 Base64 结构的数据；工具会在本地尝试解码。",
    recommendations: [
      {
        slug: "base64-codec",
        reason: "在标准 Base64、Base64URL 与 UTF-8 文本之间转换。",
      },
    ],
  };
}

function looksLikeQueryString(value: string): boolean {
  if (/\s|[\r\n]/u.test(value)) return false;
  const query = value.startsWith("?") ? value.slice(1) : value;
  if (!query || (!query.includes("=") && !query.includes("&"))) return false;

  const parts = query.split("&");
  if (
    !value.startsWith("?") &&
    parts.length === 1 &&
    isReadablePaddedBase64(query)
  ) {
    return false;
  }
  return parts.length > 0 && parts.every((part) => part.length > 0);
}

function isReadablePaddedBase64(value: string): boolean {
  if (
    value.length < 8 ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/_-]+={1,2}$/u.test(value)
  ) {
    return false;
  }

  const decoded = decodeBase64Bytes(value);
  return Boolean(decoded?.length && isDecodedBase64Readable(decoded));
}

function inspectDelimitedShape(
  value: string,
  delimiter: "," | "\t",
): { delimiter: "," | "\t"; rows: number; columns: number } | null {
  const delimiterCounts: number[] = [];
  let delimiters = 0;
  let inQuotes = false;
  let rowHasContent = false;

  function finishRow() {
    if (rowHasContent || delimiters > 0) delimiterCounts.push(delimiters);
    delimiters = 0;
    rowHasContent = false;
  }

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (character === '"') {
      if (inQuotes && value[index + 1] === '"') {
        index += 1;
        rowHasContent = true;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (!inQuotes && character === delimiter) {
      delimiters += 1;
      rowHasContent = true;
    } else if (!inQuotes && (character === "\n" || character === "\r")) {
      finishRow();
      if (character === "\r" && value[index + 1] === "\n") index += 1;
    } else if (!/\s/u.test(character)) {
      rowHasContent = true;
    }
  }

  if (inQuotes) return null;
  finishRow();

  if (delimiterCounts.length < 2) return null;
  const expected = delimiterCounts[0];
  if (
    expected === undefined ||
    expected < 1 ||
    delimiterCounts.some((count) => count !== expected)
  ) {
    return null;
  }

  return {
    delimiter,
    rows: delimiterCounts.length,
    columns: expected + 1,
  };
}

function decodeBase64UrlJson(segment: string): unknown {
  const bytes = decodeBase64Bytes(segment);
  if (!bytes) return null;

  try {
    return JSON.parse(textDecoder.decode(bytes)) as unknown;
  } catch {
    return null;
  }
}

function decodeBase64Bytes(value: string): Uint8Array | null {
  const standard = value.replace(/-/gu, "+").replace(/_/gu, "/");
  const padded = standard.padEnd(Math.ceil(standard.length / 4) * 4, "=");

  try {
    const decoded = atob(padded);
    return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype,
  );
}

function isPrintableCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0);
  if (codePoint === undefined) return false;
  return (
    codePoint === 9 ||
    codePoint === 10 ||
    codePoint === 13 ||
    (codePoint >= 32 && codePoint !== 127)
  );
}

function isDecodedBase64Readable(decoded: Uint8Array): boolean {
  try {
    const text = textDecoder.decode(decoded);
    const characters = [...text];
    const printableCharacters = characters.filter((character) =>
      isPrintableCharacter(character),
    ).length;
    return printableCharacters / Math.max(characters.length, 1) >= 0.85;
  } catch {
    return false;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

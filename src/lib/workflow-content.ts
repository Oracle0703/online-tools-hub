import {
  workflowTemplates,
  type WorkflowTemplateId,
} from "../workflows/templates";
import type { ExperienceToolSlug } from "./experience-content";

export type WorkflowContentStep = Readonly<{
  operationId: string;
  title: string;
  description: string;
}>;

export type WorkflowContentDefinition = Readonly<{
  id: WorkflowTemplateId;
  slug: WorkflowTemplateId;
  title: string;
  summary: string;
  description: string;
  eyebrow: string;
  mark: string;
  keywords: readonly string[];
  inputLabel: string;
  outputLabel: string;
  inputHelp: string;
  resultDescription: string;
  steps: readonly WorkflowContentStep[];
  notices: readonly string[];
  relatedToolSlugs: readonly ExperienceToolSlug[];
  durationMinutes: number;
}>;

export type WorkflowContentSummary = Pick<
  WorkflowContentDefinition,
  | "id"
  | "slug"
  | "title"
  | "summary"
  | "eyebrow"
  | "mark"
  | "keywords"
  | "inputLabel"
  | "outputLabel"
  | "relatedToolSlugs"
  | "durationMinutes"
> &
  Readonly<{ stepCount: number }>;

const definitions: WorkflowContentDefinition[] = [
  {
    id: "base64-json-inspect",
    slug: "base64-json-inspect",
    title: "解开 Base64 JSON",
    summary: "本地解码 Base64 API 响应，再把 JSON 整理成便于检查的格式。",
    description:
      "在浏览器本地完成 Base64 解码与 JSON 格式化，适合检查接口响应和编码配置；内容不上传，配方不保存正文。",
    eyebrow: "接口响应检查",
    mark: "B64",
    keywords: [
      "Base64 JSON",
      "Base64 解码",
      "JSON 格式化",
      "接口响应检查",
      "本地工作流",
    ],
    inputLabel: "标准 Base64 文本",
    outputLabel: "格式化 JSON 文本",
    inputHelp:
      "输入应当是标准 Base64，解码后的 UTF-8 内容必须是有效 JSON。Base64 不是加密。",
    resultDescription:
      "最终结果是带两空格缩进的 JSON 文本，可以在确认内容后主动复制或下载。",
    steps: [
      {
        operationId: "base64.codec",
        title: "解码 Base64",
        description: "按标准 Base64 规则还原 UTF-8 JSON 文本。",
      },
      {
        operationId: "json.transform",
        title: "格式化 JSON",
        description: "验证 JSON，并以两空格缩进生成可读结果。",
      },
    ],
    notices: ["Base64 只是编码，不是加密；不要用它保护机密信息。"],
    relatedToolSlugs: ["base64-codec", "json-formatter"],
    durationMinutes: 1,
  },
  {
    id: "yaml-config-to-base64url",
    slug: "yaml-config-to-base64url",
    title: "YAML 配置转 Base64URL",
    summary: "把 YAML 配置转为紧凑 JSON，再编码成 URL 安全字符集。",
    description:
      "在浏览器本地把 YAML 严格转换为 JSON、压缩并编码为 Base64URL，适合生成测试配置片段；不会上传原文。",
    eyebrow: "配置编码",
    mark: "Y→64",
    keywords: [
      "YAML 转 Base64URL",
      "YAML 转 JSON",
      "JSON 压缩",
      "配置编码",
      "本地工作流",
    ],
    inputLabel: "YAML 1.2 单文档",
    outputLabel: "Base64URL 文本",
    inputHelp:
      "只接受可映射到 JSON 数据模型的 YAML 单文档；注释、锚点写法和专有类型不会原样保留。",
    resultDescription:
      "最终结果只使用 URL 安全字符，但它仍是可逆编码，不应被当作加密或脱敏。",
    steps: [
      {
        operationId: "yaml.convert",
        title: "YAML 转 JSON",
        description: "严格解析 YAML 1.2，并转换为 JSON 数据模型。",
      },
      {
        operationId: "json.transform",
        title: "压缩 JSON",
        description: "验证转换结果并移除非必要空白。",
      },
      {
        operationId: "base64.codec",
        title: "编码 Base64URL",
        description: "把紧凑 JSON 编码为 URL 安全字符集。",
      },
    ],
    notices: ["Base64URL 仍可逆；配置中的密钥和凭据不会因此变安全。"],
    relatedToolSlugs: ["yaml-json-converter", "json-formatter", "base64-codec"],
    durationMinutes: 2,
  },
  {
    id: "csv-api-fixture-sha256",
    slug: "csv-api-fixture-sha256",
    title: "CSV 测试夹具与 SHA-256",
    summary: "把 CSV 规范化为紧凑 JSON，并为固定结果生成 SHA-256 摘要。",
    description:
      "在浏览器本地完成 CSV 转 JSON、JSON 压缩和 SHA-256 计算，适合制作可复查的 API 测试夹具。",
    eyebrow: "测试数据准备",
    mark: "CSV",
    keywords: [
      "CSV 转 JSON",
      "API 测试数据",
      "SHA-256",
      "测试夹具",
      "本地工作流",
    ],
    inputLabel: "带表头的 CSV 文本",
    outputLabel: "SHA-256 十六进制摘要",
    inputHelp:
      "自动识别逗号、分号或 Tab；单元格保持字符串，重复表头和列数不一致会被拒绝。",
    resultDescription:
      "输出是规范化 JSON 的 SHA-256 摘要。摘要用于完整性核对，不包含 JSON 正文，也不证明来源可信。",
    steps: [
      {
        operationId: "csv.convert",
        title: "CSV 转 JSON",
        description: "解析表头和行列，把单元格按字符串保存为对象数组。",
      },
      {
        operationId: "json.transform",
        title: "压缩 JSON",
        description: "生成稳定、无非必要空白的 JSON 文本。",
      },
      {
        operationId: "hash.digest",
        title: "计算 SHA-256",
        description: "为紧凑 JSON 计算十六进制摘要。",
      },
    ],
    notices: ["哈希用于核对字节完整性，不是加密，也不验证数据来源。"],
    relatedToolSlugs: [
      "csv-json-converter",
      "json-formatter",
      "hash-generator",
    ],
    durationMinutes: 2,
  },
  {
    id: "encoded-callback-query-audit",
    slug: "encoded-callback-query-audit",
    title: "回调地址参数审计",
    summary: "解开整体编码的回调地址，并按原顺序检查重复键和空参数。",
    description:
      "在浏览器本地解码 URL component 并检查查询参数，保留顺序、重复键和空值；工作流不会访问输入的网址。",
    eyebrow: "URL 参数检查",
    mark: "?&",
    keywords: [
      "URL 解码",
      "回调地址",
      "查询参数解析",
      "重复 URL 参数",
      "本地工作流",
    ],
    inputLabel: "整体百分号编码的回调地址",
    outputLabel: "查询参数 JSON 报告",
    inputHelp:
      "输入应是按 URL component 规则编码的文本。解码后只解析文本，不打开、不请求也不验证目标地址。",
    resultDescription:
      "结果保留参数顺序、重复键、空键、空值和无等号项，便于发现 OAuth 或 webhook 回调配置差异。",
    steps: [
      {
        operationId: "url.codec",
        title: "解码 URL component",
        description: "还原百分号编码，但不访问得到的网址。",
      },
      {
        operationId: "query.inspect",
        title: "检查查询参数",
        description: "按 RFC 百分号规则保序解析，并输出结构化报告。",
      },
    ],
    notices: ["工作流只处理文本，不会打开、抓取或验证解码后的 URL。"],
    relatedToolSlugs: ["url-codec", "query-params"],
    durationMinutes: 1,
  },
  {
    id: "encoded-jwt-claims",
    slug: "encoded-jwt-claims",
    title: "URL 编码 JWT 声明报告",
    summary: "先还原 URL 编码的 JWT，再查看 Header、Payload 和时间声明。",
    description:
      "在浏览器本地完成 URL 解码与 JWT 声明检查，显示 exp、nbf、iat 等调试信息；不会上传令牌，也不验证签名。",
    eyebrow: "令牌调试",
    mark: "JWT",
    keywords: ["URL 编码 JWT", "JWT 解码", "JWT exp", "令牌声明", "本地工作流"],
    inputLabel: "百分号编码的 JWT 文本",
    outputLabel: "JWT 声明 JSON 报告",
    inputHelp:
      "优先使用脱敏测试令牌。即使全程本地处理，生产凭据仍可能被屏幕共享、剪贴板历史或扩展读取。",
    resultDescription:
      "报告展示可解析的 Header、Payload 和时间提示；成功解码不代表签名有效、令牌可信或仍有权限。",
    steps: [
      {
        operationId: "url.codec",
        title: "解码 URL component",
        description: "还原 JWT 中被百分号编码的字符。",
      },
      {
        operationId: "jwt.decode",
        title: "检查 JWT 声明",
        description: "本地解析 Header、Payload 与常见时间声明，不请求密钥。",
      },
    ],
    notices: ["JWT 解码不等于验签，结果不能证明令牌有效或可信。"],
    relatedToolSlugs: ["url-codec", "jwt-decoder"],
    durationMinutes: 1,
  },
  {
    id: "png-palette-sha256",
    slug: "png-palette-sha256",
    title: "PNG 调色板编码与 SHA-256",
    summary: "把已验证 RGBA 像素编码成调色板 PNG，并计算输出摘要。",
    description:
      "在浏览器本地把已验证 RGBA 像素编码为 PNG，并计算 SHA-256；当前底层模板不等同于完整图片文件压缩流程。",
    eyebrow: "图片输出核对",
    mark: "PNG",
    keywords: [
      "RGBA 转 PNG",
      "PNG 调色板",
      "图片 SHA-256",
      "PNG 哈希",
      "本地工作流",
    ],
    inputLabel: "已验证 RGBA 像素",
    outputLabel: "PNG 文件的 SHA-256 摘要",
    inputHelp:
      "当前模板从宽、高和完整 RGBA 像素开始；普通图片文件的解码、动画处理和完整压缩参数不由这个模板隐式完成。",
    resultDescription:
      "最终输出是生成 PNG 字节的摘要。中间 PNG 仍只存在当前标签页内存，可在 Studio 提供入口时主动预览或导出。",
    steps: [
      {
        operationId: "image.rgba-to-png",
        title: "编码调色板 PNG",
        description: "把已验证 RGBA 像素编码为 128 色 PNG。",
      },
      {
        operationId: "hash.digest",
        title: "计算 SHA-256",
        description: "为生成的 PNG 字节计算十六进制摘要。",
      },
    ],
    notices: [
      "当前模板只接收已验证 RGBA；完整图片文件解码和批处理使用 Studio 明确提供的入口。",
    ],
    relatedToolSlugs: ["image-compressor", "hash-generator"],
    durationMinutes: 2,
  },
];

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) {
    return value;
  }
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    deepFreeze((value as Record<PropertyKey, unknown>)[key], seen);
  }
  return Object.freeze(value);
}

const templatesById = new Map(
  workflowTemplates.map((template) => [template.id, template]),
);

for (const definition of definitions) {
  const template = templatesById.get(definition.id);
  if (
    template === undefined ||
    template.title !== definition.title ||
    template.recipe.steps.length !== definition.steps.length ||
    template.recipe.steps.some(
      (step, index) =>
        step.operationId !== definition.steps[index]?.operationId,
    )
  ) {
    throw new Error(
      `Workflow content '${definition.id}' is out of sync with its runtime template.`,
    );
  }
  deepFreeze(definition);
}

if (
  definitions.length !== workflowTemplates.length ||
  new Set(definitions.map((definition) => definition.id)).size !==
    definitions.length
) {
  throw new Error("Workflow content must cover each runtime template once.");
}

export const workflowContents: readonly WorkflowContentDefinition[] =
  Object.freeze(definitions);

const workflowContentBySlug = new Map(
  workflowContents.map((workflow) => [workflow.slug, workflow]),
);

export function getWorkflowContent(
  slug: string,
): WorkflowContentDefinition | undefined {
  return workflowContentBySlug.get(slug as WorkflowTemplateId);
}

export function toWorkflowContentSummary(
  workflow: WorkflowContentDefinition,
): WorkflowContentSummary {
  return {
    id: workflow.id,
    slug: workflow.slug,
    title: workflow.title,
    summary: workflow.summary,
    eyebrow: workflow.eyebrow,
    mark: workflow.mark,
    keywords: workflow.keywords,
    inputLabel: workflow.inputLabel,
    outputLabel: workflow.outputLabel,
    relatedToolSlugs: workflow.relatedToolSlugs,
    durationMinutes: workflow.durationMinutes,
    stepCount: workflow.steps.length,
  };
}

export function getWorkflowContentStaticPaths() {
  return workflowContents.map((workflow) => ({
    params: { slug: workflow.slug },
    props: { workflow },
  }));
}

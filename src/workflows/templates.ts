import type { OperationSemanticType } from "../operations/contract";
import {
  WORKFLOW_RECIPE_FORMAT,
  WORKFLOW_RECIPE_VERSION,
  type WorkflowRecipeV1,
} from "./contract";

export const workflowTemplateIds = [
  "base64-json-inspect",
  "yaml-config-to-base64url",
  "csv-api-fixture-sha256",
  "encoded-callback-query-audit",
  "encoded-jwt-claims",
  "png-palette-sha256",
] as const;

export type WorkflowTemplateId = (typeof workflowTemplateIds)[number];

export interface WorkflowTemplateDefinition {
  readonly id: WorkflowTemplateId;
  readonly title: string;
  readonly description: string;
  readonly input: OperationSemanticType;
  readonly recipe: WorkflowRecipeV1;
  readonly notices: readonly string[];
}

function recipe(steps: WorkflowRecipeV1["steps"]): WorkflowRecipeV1 {
  return {
    format: WORKFLOW_RECIPE_FORMAT,
    version: WORKFLOW_RECIPE_VERSION,
    steps,
  };
}

const definitions: WorkflowTemplateDefinition[] = [
  {
    id: "base64-json-inspect",
    title: "解开 Base64 JSON",
    description: "本地解码 Base64 API 响应并格式化其中的 JSON。",
    input: { kind: "text", contentType: "application/base64" },
    recipe: recipe([
      {
        operationId: "base64.codec",
        options: {
          mode: "decode",
          variant: "standard",
          decodedContentType: "application/json",
        },
      },
      {
        operationId: "json.transform",
        options: { mode: "format", indent: 2 },
      },
    ]),
    notices: ["Base64 只是编码，不是加密。"],
  },
  {
    id: "yaml-config-to-base64url",
    title: "YAML 配置转 Base64URL",
    description: "把 YAML 转成紧凑 JSON，再编码为 URL 安全文本。",
    input: { kind: "text", contentType: "application/yaml" },
    recipe: recipe([
      {
        operationId: "yaml.convert",
        options: { direction: "yaml-to-json", jsonIndent: 2 },
      },
      {
        operationId: "json.transform",
        options: { mode: "minify", indent: 2 },
      },
      {
        operationId: "base64.codec",
        options: {
          mode: "encode",
          variant: "url",
          decodedContentType: "text/plain",
        },
      },
    ]),
    notices: ["最终结果可以安全放入 URL 字符集，但仍不是密文。"],
  },
  {
    id: "csv-api-fixture-sha256",
    title: "CSV 测试夹具与 SHA-256",
    description: "把 CSV 规范化为紧凑 JSON，并生成完整性摘要。",
    input: { kind: "text", contentType: "text/csv" },
    recipe: recipe([
      {
        operationId: "csv.convert",
        options: {
          direction: "csv-to-json",
          delimiter: "auto",
          jsonIndent: 2,
        },
      },
      {
        operationId: "json.transform",
        options: { mode: "minify", indent: 2 },
      },
      {
        operationId: "hash.digest",
        options: { algorithm: "SHA-256" },
      },
    ]),
    notices: ["摘要用于完整性核对，不证明数据来源可信。"],
  },
  {
    id: "encoded-callback-query-audit",
    title: "回调地址参数审计",
    description: "解开整体编码的回调地址，并保序检查查询参数。",
    input: {
      kind: "text",
      contentType: "application/x-www-form-urlencoded",
    },
    recipe: recipe([
      {
        operationId: "url.codec",
        options: { mode: "decode", scope: "component", formEncoding: false },
      },
      {
        operationId: "query.inspect",
        options: { encoding: "rfc3986", sort: false },
      },
    ]),
    notices: ["此模板不会打开或请求解码后的 URL。"],
  },
  {
    id: "encoded-jwt-claims",
    title: "URL 编码 JWT 声明报告",
    description: "先解开 URL 编码，再本地查看 JWT Header、Payload 与时间声明。",
    input: {
      kind: "text",
      contentType: "application/x-www-form-urlencoded",
    },
    recipe: recipe([
      {
        operationId: "url.codec",
        options: { mode: "decode", scope: "component", formEncoding: false },
      },
      { operationId: "jwt.decode", options: {} },
    ]),
    notices: ["解码不等于验签，也不能证明令牌可信。"],
  },
  {
    id: "png-palette-sha256",
    title: "PNG 调色板编码与 SHA-256",
    description: "把已验证 RGBA 像素编码成 PNG，并计算结果摘要。",
    input: { kind: "rgba-image", contentType: "image/x-rgba" },
    recipe: recipe([
      {
        operationId: "image.rgba-to-png",
        options: { paletteColors: 128 },
      },
      {
        operationId: "hash.digest",
        options: { algorithm: "SHA-256" },
      },
    ]),
    notices: ["#37 只接收已验证 RGBA；文件解码与批处理在 #35 提供。"],
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

for (const definition of definitions) deepFreeze(definition);

export const workflowTemplates: readonly WorkflowTemplateDefinition[] =
  Object.freeze(definitions);

const templateById = new Map(
  workflowTemplates.map((definition) => [definition.id, definition]),
);

export function getWorkflowTemplate(
  id: string,
): WorkflowTemplateDefinition | undefined {
  return templateById.get(id as WorkflowTemplateId);
}

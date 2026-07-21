import type {
  OperationInput,
  RgbaImageOperationInput,
} from "../operations/contract";
import { getOperationManifest } from "../operations/catalog";
import { payloadByteLength } from "../operations/validation";
import {
  MAX_IMAGE_FILE_BYTES,
  getImageMemoryLimits,
  inspectImageData,
  readImageDimensions,
  validateImageSourceMemory,
  type ImageMemoryEnvironment,
  type SupportedImageFormat,
} from "../tools/image-compressor/core";
import { getWorkflowTemplate, type WorkflowTemplateId } from "./templates";

export const MAX_WORKFLOW_BATCH_FILES = 12;
export const MAX_WORKFLOW_BATCH_SOURCE_BYTES = 64 * 1024 * 1024;

export const workflowFileInputErrorCodes = [
  "unknown-template",
  "empty-selection",
  "too-many-files",
  "invalid-file-size",
  "empty-file",
  "file-too-large",
  "total-too-large",
  "unsupported-image",
  "animated-image",
  "invalid-image",
  "device-memory-limit",
  "invalid-text",
  "decode-failed",
  "cancelled",
] as const;

export type WorkflowFileInputErrorCode =
  (typeof workflowFileInputErrorCodes)[number];

const ERROR_MESSAGES: Readonly<Record<WorkflowFileInputErrorCode, string>> =
  Object.freeze({
    "unknown-template": "无法识别这个工作流模板。",
    "empty-selection": "请至少选择一个文件。",
    "too-many-files": `一次最多处理 ${MAX_WORKFLOW_BATCH_FILES} 个文件。`,
    "invalid-file-size": "浏览器报告了无效的文件大小。",
    "empty-file": "空文件无法进入工作流。",
    "file-too-large": "文件超过当前工作流的安全大小限制。",
    "total-too-large": "所选文件的总大小超过批处理安全限制。",
    "unsupported-image": "仅支持有效的 JPEG、PNG 或 WebP 图片。",
    "animated-image": "图片工作流暂不支持动画 PNG 或动画 WebP。",
    "invalid-image": "图片容器损坏或尺寸无效。",
    "device-memory-limit": "图片尺寸超过当前设备的安全解码限制。",
    "invalid-text": "文件不是有效的 UTF-8 文本。",
    "decode-failed": "浏览器无法安全解码这个文件。",
    cancelled: "文件读取已取消。",
  });

/**
 * File errors deliberately contain neither a filename nor input fragments.
 * The UI may render a transient filename beside the item, but snapshots,
 * receipts and serialized errors stay payload-free.
 */
export class WorkflowFileInputError extends Error {
  readonly code: WorkflowFileInputErrorCode;

  constructor(code: WorkflowFileInputErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "WorkflowFileInputError";
    this.code = code;
  }

  toJSON(): Readonly<{
    name: "WorkflowFileInputError";
    code: WorkflowFileInputErrorCode;
    message: string;
  }> {
    return Object.freeze({
      name: "WorkflowFileInputError",
      code: this.code,
      message: this.message,
    });
  }
}

export interface WorkflowSourceFile {
  readonly size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface WorkflowSourceFileDescriptor {
  readonly size: number;
}

export interface WorkflowFilePolicy {
  readonly templateId: WorkflowTemplateId;
  readonly inputKind: "text" | "rgba-image";
  readonly semanticType: string;
  readonly maxSourceBytes: number;
  readonly accept: string;
}

export type WorkflowFileQueueValidation =
  | Readonly<{
      ok: true;
      value: Readonly<{
        count: number;
        totalBytes: number;
        policy: WorkflowFilePolicy;
      }>;
    }>
  | Readonly<{ ok: false; error: WorkflowFileInputError }>;

export interface WorkflowImageDecodeRequest {
  readonly file: WorkflowSourceFile;
  readonly format: SupportedImageFormat;
  readonly declaredWidth: number;
  readonly declaredHeight: number;
  readonly signal?: AbortSignal;
  readonly memoryEnvironment?: ImageMemoryEnvironment;
}

export type WorkflowImageDecoder = (
  request: WorkflowImageDecodeRequest,
) => Promise<RgbaImageOperationInput>;

export interface ReadWorkflowFileOptions {
  readonly signal?: AbortSignal;
  readonly memoryEnvironment?: ImageMemoryEnvironment;
  /** Required for image templates; the browser UI injects its local decoder. */
  readonly imageDecoder?: WorkflowImageDecoder;
}

export interface DecodedWorkflowFile {
  readonly input: OperationInput;
  readonly semanticType: string;
  readonly sourceBytes: number;
}

function failure(
  code: WorkflowFileInputErrorCode,
): WorkflowFileQueueValidation {
  return Object.freeze({ ok: false, error: new WorkflowFileInputError(code) });
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new WorkflowFileInputError("cancelled");
}

function readMemoryEnvironment(): ImageMemoryEnvironment {
  const deviceMemoryGiB =
    typeof navigator === "undefined"
      ? undefined
      : (navigator as Navigator & { readonly deviceMemory?: number })
          .deviceMemory;
  const coarsePointer =
    typeof matchMedia === "function"
      ? matchMedia("(pointer: coarse)").matches
      : undefined;
  return { deviceMemoryGiB, coarsePointer };
}

export function getWorkflowFilePolicy(
  templateId: string,
): WorkflowFilePolicy | undefined {
  const template = getWorkflowTemplate(templateId);
  const firstStep = template?.recipe.steps[0];
  const manifest =
    firstStep === undefined
      ? undefined
      : getOperationManifest(firstStep.operationId);
  if (template === undefined || manifest === undefined) return undefined;

  if (template.input.kind === "rgba-image") {
    return Object.freeze({
      templateId: template.id,
      inputKind: "rgba-image",
      semanticType: template.input.contentType,
      maxSourceBytes: MAX_IMAGE_FILE_BYTES,
      accept: "image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp",
    });
  }
  if (template.input.kind !== "text") return undefined;

  const accept =
    template.input.contentType === "application/yaml"
      ? ".yaml,.yml,application/yaml,text/yaml,text/plain"
      : template.input.contentType === "text/csv"
        ? ".csv,text/csv,text/plain"
        : "text/plain,.txt,.json,.jwt,.csv,.yaml,.yml";

  return Object.freeze({
    templateId: template.id,
    inputKind: "text",
    semanticType: template.input.contentType,
    maxSourceBytes: manifest.maxInputBytes,
    accept,
  });
}

export function validateWorkflowFileQueue(
  files: readonly WorkflowSourceFileDescriptor[],
  templateId: string,
): WorkflowFileQueueValidation {
  const policy = getWorkflowFilePolicy(templateId);
  if (policy === undefined) return failure("unknown-template");
  if (files.length === 0) return failure("empty-selection");
  if (files.length > MAX_WORKFLOW_BATCH_FILES) return failure("too-many-files");

  let totalBytes = 0;
  for (const file of files) {
    if (!Number.isSafeInteger(file.size) || file.size < 0) {
      return failure("invalid-file-size");
    }
    if (file.size === 0) return failure("empty-file");
    if (file.size > policy.maxSourceBytes) return failure("file-too-large");
    if (totalBytes > MAX_WORKFLOW_BATCH_SOURCE_BYTES - file.size) {
      return failure("total-too-large");
    }
    totalBytes += file.size;
  }

  return Object.freeze({
    ok: true,
    value: Object.freeze({ count: files.length, totalBytes, policy }),
  });
}

function canonicalImageError(code: string): WorkflowFileInputError {
  if (code === "unsupported-image") {
    return new WorkflowFileInputError("unsupported-image");
  }
  if (code === "device-memory-limit" || code === "too-many-pixels") {
    return new WorkflowFileInputError("device-memory-limit");
  }
  return new WorkflowFileInputError("invalid-image");
}

export async function readWorkflowSourceFile(
  file: WorkflowSourceFile,
  templateId: string,
  options: ReadWorkflowFileOptions = {},
): Promise<DecodedWorkflowFile> {
  const validation = validateWorkflowFileQueue([file], templateId);
  if (!validation.ok) throw validation.error;
  const { policy } = validation.value;
  throwIfCancelled(options.signal);

  let buffer: ArrayBuffer;
  try {
    buffer = await file.arrayBuffer();
  } catch {
    throwIfCancelled(options.signal);
    throw new WorkflowFileInputError("decode-failed");
  }
  throwIfCancelled(options.signal);
  if (buffer.byteLength !== file.size) {
    throw new WorkflowFileInputError("invalid-file-size");
  }

  if (policy.inputKind === "text") {
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    } catch {
      throw new WorkflowFileInputError("invalid-text");
    }
    const input = Object.freeze({ kind: "text", text }) as OperationInput;
    if (payloadByteLength(input) > policy.maxSourceBytes) {
      throw new WorkflowFileInputError("file-too-large");
    }
    return Object.freeze({
      input,
      semanticType: policy.semanticType,
      sourceBytes: file.size,
    });
  }

  const bytes = new Uint8Array(buffer);
  const inspection = inspectImageData(bytes);
  if (!inspection.ok) throw canonicalImageError(inspection.error.code);
  if (inspection.value.animated) {
    throw new WorkflowFileInputError("animated-image");
  }
  const dimensions = readImageDimensions(bytes, inspection.value.format);
  if (!dimensions.ok) throw canonicalImageError(dimensions.error.code);
  const memoryEnvironment =
    options.memoryEnvironment ?? readMemoryEnvironment();
  const memory = validateImageSourceMemory(
    dimensions.value.width,
    dimensions.value.height,
    getImageMemoryLimits(memoryEnvironment),
  );
  if (!memory.ok) throw canonicalImageError(memory.error.code);
  throwIfCancelled(options.signal);

  const imageDecoder = options.imageDecoder;
  if (imageDecoder === undefined) {
    throw new WorkflowFileInputError("decode-failed");
  }

  let input: RgbaImageOperationInput;
  try {
    input = await imageDecoder({
      file,
      format: inspection.value.format,
      declaredWidth: dimensions.value.width,
      declaredHeight: dimensions.value.height,
      signal: options.signal,
      memoryEnvironment,
    });
  } catch (error) {
    if (error instanceof WorkflowFileInputError) throw error;
    throwIfCancelled(options.signal);
    throw new WorkflowFileInputError("decode-failed");
  }
  throwIfCancelled(options.signal);

  if (
    input.kind !== "rgba-image" ||
    !Number.isSafeInteger(input.width) ||
    !Number.isSafeInteger(input.height) ||
    input.width <= 0 ||
    input.height <= 0 ||
    !(input.data instanceof Uint8ClampedArray) ||
    input.data.byteLength !== input.width * input.height * 4
  ) {
    throw new WorkflowFileInputError("decode-failed");
  }
  const decodedMemory = validateImageSourceMemory(
    input.width,
    input.height,
    getImageMemoryLimits(memoryEnvironment),
  );
  if (!decodedMemory.ok) throw canonicalImageError(decodedMemory.error.code);

  return Object.freeze({
    input,
    semanticType: policy.semanticType,
    sourceBytes: file.size,
  });
}

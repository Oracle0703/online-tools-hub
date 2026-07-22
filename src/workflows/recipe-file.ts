import { MAX_WORKFLOW_RECIPE_BYTES, type WorkflowRecipeV1 } from "./contract";
import { compileWorkflowCandidate } from "./planner";
import {
  exportWorkflowRecipeCanonical,
  parseWorkflowRecipe,
} from "./recipe-codec";

export const WORKFLOW_RECIPE_DOWNLOAD_FILENAME = "workflow-recipe.json";

export const workflowRecipeFileErrorCodes = [
  "invalid-file",
  "empty-file",
  "file-too-large",
  "read-failed",
  "invalid-text",
  "invalid-recipe",
  "download-unavailable",
] as const;

export type WorkflowRecipeFileErrorCode =
  (typeof workflowRecipeFileErrorCodes)[number];

const ERROR_MESSAGES: Readonly<Record<WorkflowRecipeFileErrorCode, string>> =
  Object.freeze({
    "invalid-file": "请选择有效的工作流配方文件。",
    "empty-file": "工作流配方文件不能为空。",
    "file-too-large": "工作流配方文件超过 64 KiB 安全限制。",
    "read-failed": "无法安全读取工作流配方文件。",
    "invalid-text": "工作流配方文件不是有效的 UTF-8 文本。",
    "invalid-recipe": "工作流配方无效或不受支持。",
    "download-unavailable": "浏览器无法安全下载工作流配方。",
  });

/** Stable, payload-free errors: filenames, source text and lower errors vanish. */
export class WorkflowRecipeFileError extends Error {
  readonly code: WorkflowRecipeFileErrorCode;

  constructor(code: WorkflowRecipeFileErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "WorkflowRecipeFileError";
    this.code = code;
  }

  toJSON(): Readonly<{
    name: "WorkflowRecipeFileError";
    code: WorkflowRecipeFileErrorCode;
    message: string;
  }> {
    return Object.freeze({
      name: "WorkflowRecipeFileError",
      code: this.code,
      message: this.message,
    });
  }
}

export interface ImportedWorkflowRecipeFile {
  /** The catalog-validated, default-materialized recipe. */
  readonly recipe: WorkflowRecipeV1;
  /** The only wire representation that callers may copy, save or download. */
  readonly canonical: string;
}

export interface WorkflowRecipeDownloadEnvironment {
  readonly createObjectUrl: (blob: Blob) => string;
  readonly revokeObjectUrl: (url: string) => void;
  readonly triggerDownload: (url: string, filename: string) => void;
  readonly schedule: (callback: () => void, delayMs: number) => unknown;
}

function fail(code: WorkflowRecipeFileErrorCode): never {
  throw new WorkflowRecipeFileError(code);
}

function canonicalRecipe(value: unknown): ImportedWorkflowRecipeFile {
  try {
    const plan = compileWorkflowCandidate(value);
    const canonical = exportWorkflowRecipeCanonical(plan.recipe);
    return Object.freeze({ recipe: plan.recipe, canonical });
  } catch {
    return fail("invalid-recipe");
  }
}

function isLocalFile(value: unknown): value is File {
  return typeof File === "function" && value instanceof File;
}

/**
 * Reads one explicitly selected browser File. The source name is never read,
 * returned or included in an error. Size is checked on both sides of the read
 * so a changed/truncated result cannot cross the recipe boundary unnoticed.
 */
export async function readWorkflowRecipeFile(
  file: File,
): Promise<ImportedWorkflowRecipeFile> {
  if (!isLocalFile(file)) fail("invalid-file");

  let declaredSize: number;
  try {
    declaredSize = file.size;
  } catch {
    return fail("invalid-file");
  }
  if (!Number.isSafeInteger(declaredSize) || declaredSize < 0) {
    fail("invalid-file");
  }
  if (declaredSize === 0) fail("empty-file");
  if (declaredSize > MAX_WORKFLOW_RECIPE_BYTES) fail("file-too-large");

  let buffer: ArrayBuffer;
  try {
    buffer = await file.arrayBuffer();
  } catch {
    return fail("read-failed");
  }
  if (!(buffer instanceof ArrayBuffer)) fail("read-failed");
  if (buffer.byteLength === 0) fail("empty-file");
  if (buffer.byteLength > MAX_WORKFLOW_RECIPE_BYTES) fail("file-too-large");
  if (buffer.byteLength !== declaredSize) fail("invalid-file");

  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return fail("invalid-text");
  }

  try {
    return canonicalRecipe(parseWorkflowRecipe(source));
  } catch {
    return fail("invalid-recipe");
  }
}

function browserDownloadEnvironment(): WorkflowRecipeDownloadEnvironment {
  if (
    typeof document === "undefined" ||
    document.body === null ||
    typeof URL.createObjectURL !== "function" ||
    typeof URL.revokeObjectURL !== "function" ||
    typeof setTimeout !== "function"
  ) {
    return fail("download-unavailable");
  }

  return {
    createObjectUrl: (blob) => URL.createObjectURL(blob),
    revokeObjectUrl: (url) => URL.revokeObjectURL(url),
    triggerDownload(url, filename) {
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      link.rel = "noopener";
      document.body.append(link);
      try {
        link.click();
      } finally {
        link.remove();
      }
    },
    schedule: (callback, delayMs) => setTimeout(callback, delayMs),
  };
}

function safelyRevokeObjectUrl(
  environment: WorkflowRecipeDownloadEnvironment,
  objectUrl: string,
): void {
  try {
    environment.revokeObjectUrl(objectUrl);
  } catch {
    // Revocation is best-effort, and browser details never enter a UI error.
  }
}

/**
 * Call directly from a user click handler. Only a canonical v1 recipe enters
 * the Blob; the fixed download name never derives from an imported filename.
 */
export function downloadWorkflowRecipeFile(
  value: unknown,
  injectedEnvironment?: WorkflowRecipeDownloadEnvironment,
): void {
  const { canonical } = canonicalRecipe(value);
  let environment: WorkflowRecipeDownloadEnvironment;
  try {
    environment = injectedEnvironment ?? browserDownloadEnvironment();
  } catch {
    return fail("download-unavailable");
  }

  let objectUrl: string | undefined;
  try {
    const blob = new Blob([canonical], {
      type: "application/json;charset=utf-8",
    });
    objectUrl = environment.createObjectUrl(blob);
    if (typeof objectUrl !== "string" || objectUrl.length === 0) {
      fail("download-unavailable");
    }
    environment.triggerDownload(objectUrl, WORKFLOW_RECIPE_DOWNLOAD_FILENAME);
  } catch {
    return fail("download-unavailable");
  } finally {
    if (objectUrl !== undefined) {
      try {
        environment.schedule(
          () => safelyRevokeObjectUrl(environment, objectUrl!),
          0,
        );
      } catch {
        safelyRevokeObjectUrl(environment, objectUrl);
      }
    }
  }
}

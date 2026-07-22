import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import {
  getOperationManifest,
  operationManifests,
} from "../../operations/catalog";
import type {
  JsonObject,
  JsonPrimitive,
  OperationManifest,
  OperationOptionSchema,
} from "../../operations/contract";
import { normalizeOperationOptions } from "../../operations/validation";
import {
  MAX_WORKFLOW_RECIPE_STEPS,
  WORKFLOW_RECIPE_FORMAT,
  WORKFLOW_RECIPE_VERSION,
  type WorkflowRecipeV1,
} from "../../workflows/contract";
import { isWorkflowError } from "../../workflows/errors";
import {
  PayloadVault,
  type PayloadPreview,
} from "../../workflows/payload-vault";
import {
  compileWorkflowCandidate,
  type WorkflowPlan,
} from "../../workflows/planner";
import {
  exportWorkflowRecipeCanonical,
  parseWorkflowRecipe,
} from "../../workflows/recipe-codec";
import {
  WorkflowRunner,
  type WorkflowRun,
  type WorkflowRunSnapshot,
  type WorkflowStepStatus,
} from "../../workflows/runner";
import {
  getWorkflowTemplate,
  workflowTemplates,
  type WorkflowTemplateDefinition,
  type WorkflowTemplateId,
} from "../../workflows/templates";
import WorkflowBatchPanel from "./WorkflowBatchPanel";
import WorkflowRecipeLibraryPanel from "./WorkflowRecipeLibraryPanel";
import "./WorkflowStudio.css";

const STUDIO_PREVIEW_BYTES = 4 * 1024;

const operationLabels: Readonly<Record<string, string>> = Object.freeze({
  "json.transform": "JSON 格式化",
  "base64.codec": "Base64 编解码",
  "url.codec": "URL 编解码",
  "timestamp.convert": "时间戳转换",
  "uuid.generate": "UUID 生成",
  "image.rgba-to-png": "RGBA 转 PNG",
  "qr.transform": "二维码生成 / 识别",
  "text.diff": "文本差异",
  "regex.test": "正则测试",
  "hash.digest": "哈希摘要",
  "yaml.convert": "YAML / JSON",
  "jwt.decode": "JWT 解码",
  "csv.convert": "CSV / JSON",
  "query.inspect": "查询参数检查",
});

const optionLabels: Readonly<Record<string, string>> = Object.freeze({
  algorithm: "算法",
  count: "数量",
  decodedContentType: "解码后内容类型",
  delimiter: "分隔符",
  direction: "转换方向",
  displaySize: "显示尺寸",
  ecc: "纠错级别",
  encoding: "编码规则",
  formEncoding: "表单编码",
  ignoreCase: "忽略大小写",
  ignoreWhitespace: "忽略空白",
  indent: "缩进",
  interpretation: "时区解释",
  inversionAttempts: "反色识别",
  jsonIndent: "JSON 缩进",
  locale: "语言区域",
  mode: "模式",
  paletteColors: "调色板颜色数",
  scope: "处理范围",
  sort: "排序参数",
  timeZone: "时区",
  unit: "时间单位",
  variant: "Base64 变体",
});

const workflowErrorMessages: Readonly<Record<string, string>> = Object.freeze({
  cancelled: "流程已取消，临时正文和中间结果已释放。",
  "incompatible-step": "步骤之间的数据类型无法衔接，请调整顺序或选项。",
  "invalid-options": "某个步骤的选项无效，请检查标记的配置。",
  "invalid-recipe": "配方结构无效，请至少保留一个可执行步骤。",
  "operation-failed": "某个步骤执行失败，输入可能不符合该工具的格式要求。",
  "recipe-too-large": "配方超过 64 KiB，无法导入或运行。",
  "run-conflict": "已有流程正在运行，请先取消。",
  "too-many-steps": `一个流程最多包含 ${MAX_WORKFLOW_RECIPE_STEPS} 个步骤。`,
  "unknown-operation": "配方引用了当前版本不支持的操作。",
  "unsafe-value": "配方包含不安全的字段、地址或值。",
  "unsupported-format": "这不是 Online Tools Hub 的工作流配方。",
  "unsupported-version": "配方版本暂不受支持。",
  "vault-limit": "本次流程需要的内存超过当前标签页安全预算。",
});

type StudioRuntimeStatus =
  "idle" | "running" | "succeeded" | "failed" | "cancelled";

type StudioFeedback = Readonly<{
  kind: "idle" | "success" | "warning" | "error";
  message: string;
}>;

interface EditorStep {
  readonly key: string;
  readonly operationId: string;
  readonly options: Readonly<Record<string, JsonPrimitive>>;
}

interface StepRuntimeView {
  readonly status: WorkflowStepStatus;
  readonly preview?: PayloadPreview;
  readonly errorCode?: string;
}

export interface StudioInputDescriptor {
  readonly kind: "empty" | "text" | "unsupported";
  readonly contentType?: string;
  readonly reason?: string;
}

export interface WorkflowStudioProps {
  readonly templateId?: WorkflowTemplateId;
  readonly baseUrl?: string;
}

function operationLabel(operationId: string): string {
  return operationLabels[operationId] ?? operationId;
}

function optionLabel(name: string): string {
  return optionLabels[name] ?? name.replace(/([a-z])([A-Z])/gu, "$1 $2");
}

function defaultOptions(
  manifest: OperationManifest,
): Record<string, JsonPrimitive> {
  const normalized = normalizeOperationOptions(manifest, {});
  const resolved: Record<string, JsonPrimitive> = {};
  for (const [name, value] of Object.entries(normalized)) {
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      resolved[name] = value;
    }
  }
  return resolved;
}

function editorStepsFromRecipe(recipe: WorkflowRecipeV1): EditorStep[] {
  return recipe.steps.map((step, index) => ({
    key: `workflow-editor-step-${index + 1}`,
    operationId: step.operationId,
    options: { ...step.options } as Readonly<Record<string, JsonPrimitive>>,
  }));
}

function recipeFromEditorSteps(steps: readonly EditorStep[]): WorkflowRecipeV1 {
  return {
    format: WORKFLOW_RECIPE_FORMAT,
    version: WORKFLOW_RECIPE_VERSION,
    steps: steps.map((step) => ({
      operationId: step.operationId,
      options: { ...step.options } satisfies JsonObject,
    })),
  };
}

function resolveTemplate(
  templateId: WorkflowTemplateId | undefined,
): WorkflowTemplateDefinition | undefined {
  return templateId === undefined ? undefined : getWorkflowTemplate(templateId);
}

export function searchOperations(query: string): readonly OperationManifest[] {
  const normalized = query.trim().toLocaleLowerCase("zh-CN");
  if (normalized === "") return operationManifests;
  const tokens = normalized.split(/\s+/u);
  return operationManifests.filter((manifest) => {
    const id = manifest.id.toLocaleLowerCase("en-US");
    const label = operationLabel(manifest.id).toLocaleLowerCase("zh-CN");
    const searchable = `${label} ${id}`;
    return tokens.every((token) => searchable.includes(token));
  });
}

function friendlyError(error: unknown): string {
  if (isWorkflowError(error)) {
    const prefix =
      error.stepIndex === undefined ? "" : `第 ${error.stepIndex + 1} 步：`;
    return `${prefix}${workflowErrorMessages[error.code] ?? "流程执行失败。"}`;
  }
  return "无法完成此操作，请检查配方与输入后重试。";
}

function byteLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

function statusLabel(status: WorkflowStepStatus | "idle"): string {
  switch (status) {
    case "idle":
      return "待运行";
    case "pending":
      return "等待中";
    case "running":
      return "运行中";
    case "succeeded":
      return "已完成";
    case "failed":
      return "失败";
    case "cancelled":
      return "已取消";
  }
}

function isCompatibleContentType(actual: string, accepted: string): boolean {
  const [actualType, actualSubtype] = actual.split("/", 2);
  const [acceptedType, acceptedSubtype] = accepted.split("/", 2);
  return (
    (acceptedType === "*" || acceptedType === actualType) &&
    (acceptedSubtype === "*" || acceptedSubtype === actualSubtype)
  );
}

export function resolveStudioInput(
  plan: WorkflowPlan | undefined,
  editorStepCount: number,
  preferred?: WorkflowTemplateDefinition["input"],
): StudioInputDescriptor {
  const first = plan?.steps[0];
  if (first === undefined) {
    return {
      kind: "unsupported",
      reason:
        editorStepCount === 0
          ? "请先添加至少一个步骤。"
          : "当前步骤链尚未通过校验，请先修复选项或类型衔接。",
    };
  }

  if (preferred !== undefined) {
    const preferredMatch = first.input.find(
      (candidate) =>
        candidate.kind === preferred.kind &&
        isCompatibleContentType(preferred.contentType, candidate.contentType),
    );
    if (preferredMatch?.kind === "text") {
      return { kind: "text", contentType: preferred.contentType };
    }
    if (preferredMatch?.kind === "empty") {
      return { kind: "empty", contentType: preferred.contentType };
    }
  }

  const text = first.input.find((candidate) => candidate.kind === "text");
  if (text !== undefined) {
    return { kind: "text", contentType: text.contentType };
  }
  const empty = first.input.find((candidate) => candidate.kind === "empty");
  if (empty !== undefined) {
    return { kind: "empty", contentType: empty.contentType };
  }
  if (first.input.some((candidate) => candidate.kind === "rgba-image")) {
    return {
      kind: "unsupported",
      reason:
        "RGBA 像素不能从普通文件安全推断，请载入内置图片工作流完成受限解码。",
    };
  }
  if (first.input.some((candidate) => candidate.kind === "text-pair")) {
    return {
      kind: "unsupported",
      reason:
        "双文本正文不能由单输入框安全推断，请从文本差异工具分别提供两段正文。",
    };
  }
  return {
    kind: "unsupported",
    reason:
      "任意二进制类型不会被隐式接入，请先使用能产生兼容二进制结果的受控步骤。",
  };
}

export function customPlanNotices(
  plan: WorkflowPlan | undefined,
  input: StudioInputDescriptor,
  editorStepCount: number,
): readonly string[] {
  const first = plan?.steps[0];
  if (first === undefined) {
    return Object.freeze([
      editorStepCount === 0
        ? "这是 0 步空白配方；添加第一步后才会建立输入与文件策略。"
        : "当前步骤链尚未通过校验；修复选项或类型衔接后才会建立输入与文件策略。",
    ]);
  }
  if (input.kind === "text") {
    return Object.freeze([
      `当前首步“${operationLabel(first.operationId)}”按 ${input.contentType ?? "text/plain"} 接收文本。`,
      "批处理只会严格解码 UTF-8 文本，不会把文件隐式转换成其他数据类型。",
    ]);
  }
  if (input.kind === "empty") {
    return Object.freeze([
      `当前首步“${operationLabel(first.operationId)}”无需正文输入，可直接在本地运行。`,
    ]);
  }
  return Object.freeze([input.reason ?? "当前首步没有安全的通用输入方式。"]);
}

function normalizeBaseUrl(baseUrl: string | undefined): string {
  const normalized = (baseUrl ?? "/").replace(/\/+$/u, "");
  return normalized === "" ? "" : normalized;
}

function OptionEditor({
  name,
  schema,
  value,
  disabled,
  inputId,
  onChange,
}: {
  readonly name: string;
  readonly schema: OperationOptionSchema;
  readonly value: JsonPrimitive;
  readonly disabled: boolean;
  readonly inputId: string;
  readonly onChange: (value: JsonPrimitive) => void;
}) {
  const label = optionLabel(name);

  if (schema.type === "boolean") {
    return (
      <label
        className="workflow-studio__boolean-option"
        data-option-name={name}
      >
        <span>
          <strong>{label}</strong>
          <small>{value === true ? "已开启" : "已关闭"}</small>
        </span>
        <input
          id={inputId}
          type="checkbox"
          checked={value === true}
          disabled={disabled}
          onChange={(event) => onChange(event.currentTarget.checked)}
        />
      </label>
    );
  }

  if (schema.type === "enum") {
    const selectedIndex = Math.max(
      0,
      schema.values.findIndex((candidate) => Object.is(candidate, value)),
    );
    return (
      <label className="workflow-studio__option" data-option-name={name}>
        <span>{label}</span>
        <select
          id={inputId}
          value={String(selectedIndex)}
          disabled={disabled}
          onChange={(event) => {
            const next = schema.values[Number(event.currentTarget.value)];
            if (next !== undefined) onChange(next);
          }}
        >
          {schema.values.map((candidate, index) => (
            <option key={`${name}-${index}`} value={String(index)}>
              {candidate === null ? "空值" : String(candidate)}
            </option>
          ))}
        </select>
      </label>
    );
  }

  if (schema.type === "integer" || schema.type === "number") {
    return (
      <label className="workflow-studio__option" data-option-name={name}>
        <span>{label}</span>
        <input
          id={inputId}
          type="number"
          value={typeof value === "number" ? value : schema.minimum}
          min={schema.minimum}
          max={schema.maximum}
          step={schema.type === "integer" ? 1 : "any"}
          disabled={disabled}
          onChange={(event) => {
            const next = Number(event.currentTarget.value);
            if (Number.isFinite(next)) onChange(next);
          }}
        />
        <small>
          {schema.minimum}–{schema.maximum}
        </small>
      </label>
    );
  }

  return (
    <label className="workflow-studio__option" data-option-name={name}>
      <span>{label}</span>
      <input
        id={inputId}
        type="text"
        value={typeof value === "string" ? value : ""}
        minLength={schema.minimumLength}
        maxLength={schema.maximumLength}
        disabled={disabled}
        placeholder={schema.nullable ? "留空表示未设置" : undefined}
        onChange={(event) =>
          onChange(
            schema.nullable && event.currentTarget.value === ""
              ? null
              : event.currentTarget.value,
          )
        }
      />
    </label>
  );
}

function PreviewBlock({ preview }: { readonly preview: PayloadPreview }) {
  if (preview.kind === "text") {
    return (
      <div className="workflow-studio__preview" data-preview-kind="text">
        <div className="workflow-studio__preview-head">
          <span>文本预览</span>
          <span>
            {byteLabel(preview.bytes)}
            {preview.truncated ? " · 已截断" : ""}
          </span>
        </div>
        <pre>{preview.text || "（空文本）"}</pre>
      </div>
    );
  }

  if (preview.kind === "binary") {
    return (
      <div className="workflow-studio__preview" data-preview-kind="binary">
        <div className="workflow-studio__preview-head">
          <span>二进制结果</span>
          <span>{byteLabel(preview.bytes)}</span>
        </div>
        <p>{preview.mimeType ?? preview.semanticType}</p>
      </div>
    );
  }

  if (preview.kind === "rgba-image") {
    return (
      <div className="workflow-studio__preview" data-preview-kind="rgba-image">
        <div className="workflow-studio__preview-head">
          <span>RGBA 像素</span>
          <span>{byteLabel(preview.bytes)}</span>
        </div>
        <p>
          {preview.width} × {preview.height}
        </p>
      </div>
    );
  }

  if (preview.kind === "text-pair") {
    return (
      <div className="workflow-studio__preview" data-preview-kind="text-pair">
        <div className="workflow-studio__preview-head">
          <span>双文本预览</span>
          <span>{preview.truncated ? "已截断" : byteLabel(preview.bytes)}</span>
        </div>
        <pre>{`${preview.left}\n—\n${preview.right}`}</pre>
      </div>
    );
  }

  return (
    <div className="workflow-studio__preview" data-preview-kind="empty">
      <p>此步骤不需要正文输入。</p>
    </div>
  );
}

export default function WorkflowStudio({
  templateId,
  baseUrl,
}: WorkflowStudioProps) {
  const studioId = useId();
  const feedbackId = useId();
  const inputId = useId();
  const importId = useId();
  const exportId = useId();
  const initialTemplate = useMemo(
    () => resolveTemplate(templateId),
    [templateId],
  );
  const [selectedTemplateId, setSelectedTemplateId] = useState<
    WorkflowTemplateId | "custom"
  >(initialTemplate?.id ?? "custom");
  const [steps, setSteps] = useState<EditorStep[]>(() =>
    initialTemplate === undefined
      ? []
      : editorStepsFromRecipe(initialTemplate.recipe),
  );
  const [addOperationId, setAddOperationId] = useState(
    operationManifests[0]?.id ?? "json.transform",
  );
  const [operationSearch, setOperationSearch] = useState("");
  const [input, setInput] = useState("");
  const [importDraft, setImportDraft] = useState("");
  const [exportDraft, setExportDraft] = useState("");
  const [runtimeReady, setRuntimeReady] = useState(false);
  const [runtimeStatus, setRuntimeStatus] =
    useState<StudioRuntimeStatus>("idle");
  const [runtimeViews, setRuntimeViews] = useState<readonly StepRuntimeView[]>(
    [],
  );
  const [batchResetSequence, setBatchResetSequence] = useState(0);
  const [batchBusy, setBatchBusy] = useState(false);
  const [feedback, setFeedback] = useState<StudioFeedback>(() => ({
    kind: "idle",
    message:
      initialTemplate === undefined
        ? "空白配方已就绪；先搜索并添加一个本地操作。"
        : "正文和中间结果只保存在当前标签页内存中。",
  }));

  const runnerRef = useRef<WorkflowRunner | null>(null);
  const activeRunRef = useRef<WorkflowRun | null>(null);
  const pollTimerRef = useRef<number | null>(null);
  const addedStepSequenceRef = useRef(MAX_WORKFLOW_RECIPE_STEPS);
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const activeTemplate =
    selectedTemplateId === "custom"
      ? undefined
      : getWorkflowTemplate(selectedTemplateId);
  const filteredOperations = useMemo(
    () => searchOperations(operationSearch),
    [operationSearch],
  );
  const selectedAddOperationId = filteredOperations.some(
    (manifest) => manifest.id === addOperationId,
  )
    ? addOperationId
    : (filteredOperations[0]?.id ?? "");

  const recipe = useMemo(() => recipeFromEditorSteps(steps), [steps]);
  const batchPanelKey = useMemo(
    () =>
      `${batchResetSequence}:${selectedTemplateId}:${JSON.stringify(recipe)}`,
    [batchResetSequence, recipe, selectedTemplateId],
  );
  const planResult = useMemo<
    | { readonly ok: true; readonly plan: WorkflowPlan }
    | { readonly ok: false; readonly message: string }
  >(() => {
    try {
      return { ok: true, plan: compileWorkflowCandidate(recipe) };
    } catch (error) {
      return { ok: false, message: friendlyError(error) };
    }
  }, [recipe]);
  const plan = planResult.ok ? planResult.plan : undefined;
  const studioInput = resolveStudioInput(
    plan,
    steps.length,
    activeTemplate?.input,
  );
  const notices = useMemo(
    () =>
      activeTemplate === undefined
        ? customPlanNotices(plan, studioInput, steps.length)
        : activeTemplate.notices,
    [activeTemplate, plan, steps.length, studioInput],
  );
  const inputBytes = useMemo(
    () => new TextEncoder().encode(input).byteLength,
    [input],
  );
  const firstManifest =
    plan?.steps[0] === undefined
      ? undefined
      : getOperationManifest(plan.steps[0].operationId);
  const inputOverLimit =
    studioInput.kind === "text" &&
    firstManifest !== undefined &&
    inputBytes > firstManifest.maxInputBytes;
  const isRunning = runtimeStatus === "running";
  const canRun =
    runtimeReady &&
    !isRunning &&
    !batchBusy &&
    plan !== undefined &&
    !inputOverLimit &&
    (studioInput.kind === "empty" ||
      (studioInput.kind === "text" && input.length > 0));

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current !== null) {
      window.clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const syncRuntime = useCallback((snapshot?: WorkflowRunSnapshot | null) => {
    const runner = runnerRef.current;
    if (runner === null) return;
    const run = snapshot ?? runner.snapshot().run;
    if (run === null) {
      setRuntimeViews([]);
      return;
    }

    const nextViews = run.steps.map<StepRuntimeView>((step) => {
      let preview: PayloadPreview | undefined;
      if (
        step.outputPayloadId !== undefined &&
        runner.vault.has(step.outputPayloadId)
      ) {
        try {
          preview = runner.vault.preview(
            step.outputPayloadId,
            STUDIO_PREVIEW_BYTES,
          );
        } catch {
          preview = undefined;
        }
      }
      return {
        status: step.status,
        ...(preview === undefined ? {} : { preview }),
        ...(step.errorCode === undefined ? {} : { errorCode: step.errorCode }),
      };
    });
    setRuntimeViews(nextViews);
  }, []);

  const resetRuntime = useCallback(() => {
    const active = activeRunRef.current;
    activeRunRef.current = null;
    active?.cancel();
    stopPolling();
    runnerRef.current?.clear();
    setRuntimeViews([]);
    setRuntimeStatus("idle");
  }, [stopPolling]);

  useEffect(() => {
    const vault = new PayloadVault();
    const runner = new WorkflowRunner({ vault });
    const unbind = runner.bindPageHide(window);
    const clearPrivateUiState = () => {
      activeRunRef.current = null;
      stopPolling();
      setInput("");
      setImportDraft("");
      setExportDraft("");
      setRuntimeViews([]);
      setRuntimeStatus("idle");
    };
    let active = true;
    runnerRef.current = runner;
    window.addEventListener("pagehide", clearPrivateUiState);
    queueMicrotask(() => {
      if (active) setRuntimeReady(true);
    });

    return () => {
      active = false;
      activeRunRef.current = null;
      stopPolling();
      window.removeEventListener("pagehide", clearPrivateUiState);
      unbind();
      runner.dispose();
      runnerRef.current = null;
    };
  }, [stopPolling]);

  function markRecipeChanged(message: string): void {
    resetRuntime();
    setSelectedTemplateId("custom");
    setExportDraft("");
    setFeedback({ kind: "idle", message });
  }

  function loadTemplate(nextTemplateId: WorkflowTemplateId): void {
    const nextTemplate = getWorkflowTemplate(nextTemplateId);
    if (nextTemplate === undefined) return;
    resetRuntime();
    setSelectedTemplateId(nextTemplate.id);
    setSteps(editorStepsFromRecipe(nextTemplate.recipe));
    setOperationSearch("");
    setInput("");
    setImportDraft("");
    setExportDraft("");
    setFeedback({
      kind: "idle",
      message: `已载入“${nextTemplate.title}”，可以编辑步骤或直接运行。`,
    });
  }

  function loadBlankRecipe(): void {
    resetRuntime();
    setSelectedTemplateId("custom");
    setSteps([]);
    setOperationSearch("");
    setInput("");
    setImportDraft("");
    setExportDraft("");
    setFeedback({
      kind: "idle",
      message: "已创建 0 步空白配方；不会继承任何模板输入或提示。",
    });
  }

  function loadLibraryRecipe(candidate: WorkflowRecipeV1): void {
    try {
      const loadedPlan = compileWorkflowCandidate(candidate);
      resetRuntime();
      setSelectedTemplateId("custom");
      setSteps(editorStepsFromRecipe(loadedPlan.recipe));
      setOperationSearch("");
      setInput("");
      setImportDraft("");
      setExportDraft("");
      setBatchBusy(false);
      setBatchResetSequence((current) => current + 1);
      setFeedback({
        kind: "success",
        message: `本地纯配方已载入，共 ${loadedPlan.steps.length} 个步骤；正文、结果和批处理队列均已清空。`,
      });
    } catch {
      setFeedback({
        kind: "error",
        message: "无法载入这条配方；它可能已失效或不受当前版本支持。",
      });
    }
  }

  function updateOperation(stepKey: string, operationId: string): void {
    const manifest = getOperationManifest(operationId);
    if (manifest === undefined) return;
    markRecipeChanged(
      "步骤操作已更换，请检查相邻步骤的数据类型。意图正文已保留。",
    );
    setSteps((current) =>
      current.map((step) =>
        step.key === stepKey
          ? {
              ...step,
              operationId,
              options: defaultOptions(manifest),
            }
          : step,
      ),
    );
  }

  function updateOption(
    stepKey: string,
    name: string,
    value: JsonPrimitive,
  ): void {
    markRecipeChanged("步骤选项已更新，运行结果已重置。意图正文已保留。");
    setSteps((current) =>
      current.map((step) =>
        step.key === stepKey
          ? { ...step, options: { ...step.options, [name]: value } }
          : step,
      ),
    );
  }

  function moveStep(index: number, direction: -1 | 1): void {
    const target = index + direction;
    if (target < 0 || target >= steps.length) return;
    markRecipeChanged("步骤顺序已更新，请确认类型衔接后运行。意图正文已保留。");
    setSteps((current) => {
      const next = [...current];
      const [moved] = next.splice(index, 1);
      if (moved !== undefined) next.splice(target, 0, moved);
      return next;
    });
  }

  function removeStep(index: number): void {
    markRecipeChanged("步骤已删除。意图正文已保留，运行结果已清空。");
    setSteps((current) =>
      current.filter((_, itemIndex) => itemIndex !== index),
    );
  }

  function addStep(): void {
    if (steps.length >= MAX_WORKFLOW_RECIPE_STEPS) {
      setFeedback({
        kind: "warning",
        message: `一个配方最多包含 ${MAX_WORKFLOW_RECIPE_STEPS} 个步骤。`,
      });
      return;
    }
    const manifest = getOperationManifest(selectedAddOperationId);
    if (manifest === undefined) return;
    addedStepSequenceRef.current += 1;
    const stepKey = `workflow-editor-step-${addedStepSequenceRef.current}`;
    markRecipeChanged("新步骤已添加，请检查它与前一步的数据类型是否兼容。");
    setSteps((current) => [
      ...current,
      {
        key: stepKey,
        operationId: manifest.id,
        options: defaultOptions(manifest),
      },
    ]);
  }

  function importRecipe(): void {
    if (importDraft.trim() === "") {
      setFeedback({ kind: "warning", message: "请先粘贴配方 JSON。" });
      return;
    }
    try {
      const imported = parseWorkflowRecipe(importDraft);
      const importedPlan = compileWorkflowCandidate(imported);
      resetRuntime();
      setSteps(editorStepsFromRecipe(importedPlan.recipe));
      setSelectedTemplateId("custom");
      setExportDraft("");
      setFeedback({
        kind: "success",
        message: `配方已安全导入，共 ${importedPlan.steps.length} 个步骤；正文没有包含在配方中。`,
      });
    } catch (error) {
      setFeedback({ kind: "error", message: friendlyError(error) });
    }
  }

  function exportRecipe(): void {
    if (!planResult.ok) {
      setFeedback({ kind: "error", message: planResult.message });
      return;
    }
    try {
      const canonical = exportWorkflowRecipeCanonical(planResult.plan.recipe);
      setExportDraft(canonical);
      setFeedback({
        kind: "success",
        message: "纯配方已生成：只包含操作 ID 和规范化选项，不包含正文或结果。",
      });
    } catch (error) {
      setFeedback({ kind: "error", message: friendlyError(error) });
    }
  }

  async function copyCanonical(value: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      return false;
    }
  }

  async function copyExport(): Promise<void> {
    if (exportDraft === "") return;
    if (await copyCanonical(exportDraft)) {
      setFeedback({ kind: "success", message: "纯配方已复制到剪贴板。" });
    } else {
      setFeedback({
        kind: "warning",
        message: "无法访问剪贴板，请从导出框中手动复制。",
      });
    }
  }

  async function runWorkflow(): Promise<void> {
    const runner = runnerRef.current;
    if (runner === null || !canRun || plan === undefined) return;

    resetRuntime();
    setRuntimeStatus("running");
    setFeedback({
      kind: "idle",
      message: `正在本地运行 ${plan.steps.length} 个步骤…`,
    });

    let run: WorkflowRun | null = null;
    try {
      const initial =
        studioInput.kind === "empty"
          ? runner.vault.put(
              { kind: "empty" },
              studioInput.contentType ?? "application/x-empty",
            )
          : runner.vault.put(
              { kind: "text", text: input },
              studioInput.contentType ?? "text/plain",
            );
      run = runner.start(plan, initial.id);
      activeRunRef.current = run;
      syncRuntime();
      pollTimerRef.current = window.setInterval(syncRuntime, 120);

      const result = await run.promise;
      if (activeRunRef.current !== run) return;
      syncRuntime(result.snapshot);
      setRuntimeStatus("succeeded");
      setFeedback({
        kind: "success",
        message: `流程已在本地完成，共执行 ${result.snapshot.steps.length} 个步骤。`,
      });
    } catch (error) {
      if (run !== null && activeRunRef.current !== run) return;
      const cancelled = isWorkflowError(error) && error.code === "cancelled";
      syncRuntime();
      setRuntimeStatus(cancelled ? "cancelled" : "failed");
      setFeedback({
        kind: cancelled ? "warning" : "error",
        message: friendlyError(error),
      });
    } finally {
      if (run === null || activeRunRef.current === run) {
        activeRunRef.current = null;
        stopPolling();
      }
    }
  }

  function cancelWorkflow(): void {
    const run = activeRunRef.current;
    if (run === null || !run.cancel()) return;
    syncRuntime();
    setRuntimeStatus("cancelled");
    setFeedback({
      kind: "warning",
      message: workflowErrorMessages.cancelled!,
    });
  }

  function clearWorkspace(): void {
    resetRuntime();
    setInput("");
    setImportDraft("");
    setExportDraft("");
    setFeedback({
      kind: "idle",
      message: "意图正文、中间结果和导入导出草稿已从当前标签页清空。",
    });
  }

  function handleInputShortcut(
    event: ReactKeyboardEvent<HTMLTextAreaElement>,
  ): void {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && canRun) {
      event.preventDefault();
      void runWorkflow();
    }
  }

  return (
    <section
      id={studioId}
      className="workflow-studio"
      aria-labelledby={`${studioId}-title`}
      aria-describedby={feedbackId}
      aria-busy={isRunning || batchBusy}
      data-workflow-studio
      data-template-id={selectedTemplateId}
      data-source-template-id={activeTemplate?.id}
      data-step-count={steps.length}
      data-input-kind={studioInput.kind}
      data-runtime-status={runtimeStatus}
      data-batch-busy={batchBusy}
      data-base-url={normalizedBaseUrl || "/"}
    >
      <header className="workflow-studio__hero">
        <div className="workflow-studio__hero-copy">
          <p className="workflow-studio__eyebrow">
            <span aria-hidden="true" /> 本地工作流工作台
          </p>
          <h2 id={`${studioId}-title`}>把重复处理变成一条清晰流水线</h2>
          <p>
            纵向步骤是唯一编辑模型；桌面端只增加节点连线视觉，不会产生另一套交互。
          </p>
        </div>
        <div className="workflow-studio__privacy" aria-label="隐私保障">
          <span className="workflow-studio__privacy-icon" aria-hidden="true">
            ✓
          </span>
          <span>
            <strong>零上传 · 正文不持久化</strong>
            <small>仅纯配方结构可由你主动保存在本地</small>
          </span>
          <a href={`${normalizedBaseUrl}/privacy/`}>隐私说明</a>
        </div>
      </header>

      <div className="workflow-studio__template-bar">
        <label className="workflow-studio__template-select">
          <span>从内置模板开始</span>
          <select
            value={selectedTemplateId}
            disabled={isRunning}
            data-template-select
            onChange={(event) => {
              const next = event.currentTarget.value;
              if (next === "custom") {
                loadBlankRecipe();
              } else {
                loadTemplate(next as WorkflowTemplateId);
              }
            }}
          >
            <option value="custom">空白自定义配方</option>
            {workflowTemplates.map((template) => (
              <option key={template.id} value={template.id}>
                {template.title}
              </option>
            ))}
          </select>
        </label>
        <div className="workflow-studio__template-summary">
          <strong>
            {selectedTemplateId === "custom"
              ? "空白自定义配方"
              : activeTemplate?.title}
          </strong>
          <p>
            {selectedTemplateId === "custom"
              ? "完全按当前步骤推导输入与批处理策略，不继承模板正文、提示或文件类型。"
              : activeTemplate?.description}
          </p>
        </div>
        <span className="workflow-studio__step-count">
          {steps.length}/{MAX_WORKFLOW_RECIPE_STEPS} 步
        </span>
      </div>

      <WorkflowRecipeLibraryPanel
        recipe={plan?.recipe}
        disabled={isRunning || batchBusy}
        operationLabel={operationLabel}
        onLoadRecipe={loadLibraryRecipe}
        onCopyCanonical={copyCanonical}
      />

      <div className="workflow-studio__layout">
        <section
          className="workflow-studio__pipeline"
          aria-labelledby={`${studioId}-pipeline-title`}
        >
          <div className="workflow-studio__section-head">
            <div>
              <span>01</span>
              <div>
                <h3 id={`${studioId}-pipeline-title`}>编辑处理步骤</h3>
                <p>所有操作均来自本地 Operation 清单。</p>
              </div>
            </div>
            <span
              className={`workflow-studio__validity ${planResult.ok ? "is-valid" : "is-invalid"}`}
              data-recipe-valid={planResult.ok}
            >
              {planResult.ok ? "类型衔接正常" : "需要调整"}
            </span>
          </div>

          {steps.length > 0 ? (
            <ol className="workflow-studio__steps" data-workflow-steps>
              {steps.map((step, index) => {
                const manifest = getOperationManifest(step.operationId);
                const runtimeView = runtimeViews[index];
                const stepStatus = runtimeView?.status ?? "idle";
                return (
                  <li
                    key={step.key}
                    className={`workflow-studio__step is-${stepStatus}`}
                    data-workflow-step
                    data-step-index={index}
                    data-operation-id={step.operationId}
                    data-step-status={stepStatus}
                  >
                    <div className="workflow-studio__node" aria-hidden="true">
                      <span>{String(index + 1).padStart(2, "0")}</span>
                    </div>
                    <article className="workflow-studio__step-card">
                      <header className="workflow-studio__step-head">
                        <label>
                          <span className="sr-only">第 {index + 1} 步操作</span>
                          <select
                            value={step.operationId}
                            disabled={isRunning}
                            data-operation-select
                            onChange={(event) =>
                              updateOperation(
                                step.key,
                                event.currentTarget.value,
                              )
                            }
                          >
                            {operationManifests.map((operation) => (
                              <option key={operation.id} value={operation.id}>
                                {operationLabel(operation.id)} · {operation.id}
                              </option>
                            ))}
                          </select>
                        </label>
                        <span
                          className={`workflow-studio__step-status is-${stepStatus}`}
                          aria-label={`第 ${index + 1} 步${statusLabel(stepStatus)}`}
                        >
                          <i aria-hidden="true" /> {statusLabel(stepStatus)}
                        </span>
                      </header>

                      {manifest !== undefined &&
                      Object.keys(manifest.options.properties).length > 0 ? (
                        <div className="workflow-studio__options">
                          {Object.entries(manifest.options.properties).map(
                            ([name, schema]) => (
                              <OptionEditor
                                key={name}
                                name={name}
                                schema={schema}
                                value={step.options[name] ?? null}
                                disabled={isRunning}
                                inputId={`${studioId}-${step.key}-${name}`}
                                onChange={(value) =>
                                  updateOption(step.key, name, value)
                                }
                              />
                            ),
                          )}
                        </div>
                      ) : (
                        <p className="workflow-studio__no-options">
                          此操作不需要额外选项。
                        </p>
                      )}

                      <footer className="workflow-studio__step-footer">
                        <span>
                          {manifest?.determinism === "random"
                            ? "随机输出"
                            : "本地确定性处理"}
                        </span>
                        <div className="workflow-studio__step-actions">
                          <button
                            type="button"
                            disabled={isRunning || index === 0}
                            aria-label={`将第 ${index + 1} 步上移`}
                            title="上移"
                            data-action="move-up"
                            onClick={() => moveStep(index, -1)}
                          >
                            ↑
                          </button>
                          <button
                            type="button"
                            disabled={isRunning || index === steps.length - 1}
                            aria-label={`将第 ${index + 1} 步下移`}
                            title="下移"
                            data-action="move-down"
                            onClick={() => moveStep(index, 1)}
                          >
                            ↓
                          </button>
                          <button
                            type="button"
                            className="is-danger"
                            disabled={isRunning}
                            aria-label={`删除第 ${index + 1} 步`}
                            title="删除"
                            data-action="remove-step"
                            onClick={() => removeStep(index)}
                          >
                            ×
                          </button>
                        </div>
                      </footer>

                      {runtimeView?.preview !== undefined ? (
                        <div data-step-preview>
                          <PreviewBlock preview={runtimeView.preview} />
                        </div>
                      ) : null}
                      {runtimeView?.errorCode !== undefined ? (
                        <p className="workflow-studio__step-error" role="alert">
                          步骤错误：{runtimeView.errorCode}
                        </p>
                      ) : null}
                    </article>
                  </li>
                );
              })}
            </ol>
          ) : (
            <div className="workflow-studio__empty" data-workflow-empty>
              <span aria-hidden="true">＋</span>
              <h4>配方还没有步骤</h4>
              <p>从下方选择一个本地操作开始。</p>
            </div>
          )}

          <div className="workflow-studio__add-step">
            <label className="workflow-studio__operation-search">
              <span>搜索本地操作</span>
              <input
                type="search"
                value={operationSearch}
                disabled={
                  isRunning || steps.length >= MAX_WORKFLOW_RECIPE_STEPS
                }
                placeholder="输入中文名或完整 ID"
                autoComplete="off"
                spellCheck={false}
                data-operation-search
                onChange={(event) =>
                  setOperationSearch(event.currentTarget.value)
                }
              />
              <small
                role="status"
                aria-live="polite"
                aria-atomic="true"
                data-operation-result-count
              >
                {filteredOperations.length === 0
                  ? "没有匹配操作"
                  : `${filteredOperations.length}/${operationManifests.length} 项`}
              </small>
            </label>
            <label className="workflow-studio__operation-picker">
              <span className="sr-only">选择要添加的操作</span>
              <select
                value={selectedAddOperationId}
                disabled={
                  isRunning ||
                  steps.length >= MAX_WORKFLOW_RECIPE_STEPS ||
                  filteredOperations.length === 0
                }
                data-add-operation-select
                onChange={(event) =>
                  setAddOperationId(event.currentTarget.value)
                }
              >
                {filteredOperations.map((manifest) => (
                  <option key={manifest.id} value={manifest.id}>
                    {operationLabel(manifest.id)} · {manifest.id}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              disabled={
                isRunning ||
                steps.length >= MAX_WORKFLOW_RECIPE_STEPS ||
                filteredOperations.length === 0
              }
              data-action="add-step"
              onClick={addStep}
            >
              <span aria-hidden="true">＋</span> 添加步骤
            </button>
          </div>

          {!planResult.ok ? (
            <p className="workflow-studio__plan-error" role="status">
              <span aria-hidden="true">!</span> {planResult.message}
            </p>
          ) : null}
        </section>

        <aside className="workflow-studio__workspace">
          <section
            className="workflow-studio__input-panel"
            aria-labelledby={`${studioId}-input-title`}
          >
            <div className="workflow-studio__section-head">
              <div>
                <span>02</span>
                <div>
                  <h3 id={`${studioId}-input-title`}>输入与运行</h3>
                  <p>不会写入 URL、历史记录或浏览器存储。</p>
                </div>
              </div>
            </div>

            {studioInput.kind === "text" ? (
              <label className="workflow-studio__input-editor">
                <span>
                  <strong>意图正文</strong>
                  <small className={inputOverLimit ? "is-over" : undefined}>
                    {byteLabel(inputBytes)}
                    {firstManifest === undefined
                      ? ""
                      : ` / ${byteLabel(firstManifest.maxInputBytes)}`}
                  </small>
                </span>
                <textarea
                  id={inputId}
                  value={input}
                  disabled={isRunning}
                  aria-invalid={inputOverLimit}
                  aria-describedby={feedbackId}
                  aria-keyshortcuts="Control+Enter Meta+Enter"
                  placeholder="粘贴待处理文本…"
                  autoComplete="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  data-workflow-input
                  onChange={(event) => {
                    resetRuntime();
                    setInput(event.currentTarget.value);
                    setFeedback({
                      kind: "idle",
                      message: "正文仅保留在当前标签页内存中。",
                    });
                  }}
                  onKeyDown={handleInputShortcut}
                />
              </label>
            ) : studioInput.kind === "empty" ? (
              <div className="workflow-studio__input-notice is-ready">
                <span aria-hidden="true">◇</span>
                <div>
                  <strong>此流程无需正文输入</strong>
                  <p>运行时会创建一个零字节内存句柄。</p>
                </div>
              </div>
            ) : (
              <div className="workflow-studio__input-notice">
                <span aria-hidden="true">↗</span>
                <div>
                  <strong>当前输入类型未接入</strong>
                  <p>{studioInput.reason}</p>
                </div>
              </div>
            )}

            <div className="workflow-studio__run-actions">
              <button
                type="button"
                className="workflow-studio__primary"
                disabled={!canRun}
                aria-keyshortcuts="Control+Enter Meta+Enter"
                data-action="run"
                onClick={() => void runWorkflow()}
              >
                <span aria-hidden="true">▶</span>
                {isRunning ? "正在运行" : "运行工作流"}
              </button>
              <button
                type="button"
                disabled={!isRunning}
                data-action="cancel"
                onClick={cancelWorkflow}
              >
                取消
              </button>
              <button
                type="button"
                data-action="clear"
                onClick={clearWorkspace}
              >
                清空
              </button>
            </div>

            <div
              id={feedbackId}
              className={`workflow-studio__feedback is-${feedback.kind}`}
              role={feedback.kind === "error" ? "alert" : "status"}
              aria-live="polite"
              aria-atomic="true"
              data-workflow-feedback={feedback.kind}
            >
              <span aria-hidden="true">
                {feedback.kind === "success"
                  ? "✓"
                  : feedback.kind === "error"
                    ? "!"
                    : feedback.kind === "warning"
                      ? "·"
                      : "i"}
              </span>
              <p>{feedback.message}</p>
            </div>

            {notices.length > 0 ? (
              <ul className="workflow-studio__notices">
                {notices.map((notice) => (
                  <li key={notice}>{notice}</li>
                ))}
              </ul>
            ) : null}
          </section>

          <details className="workflow-studio__recipe-panel">
            <summary>
              <span>
                <strong>导入 / 导出纯配方</strong>
                <small>配方永不包含正文、文件名或结果</small>
              </span>
              <span aria-hidden="true">⌄</span>
            </summary>
            <div className="workflow-studio__recipe-body">
              <label>
                <span>导入配方 JSON</span>
                <textarea
                  id={importId}
                  value={importDraft}
                  disabled={isRunning}
                  placeholder='{"format":"online-tools-hub/workflow",…}'
                  autoComplete="off"
                  spellCheck={false}
                  data-recipe-import
                  onChange={(event) =>
                    setImportDraft(event.currentTarget.value)
                  }
                />
              </label>
              <button
                type="button"
                disabled={isRunning || importDraft.trim() === ""}
                data-action="import-recipe"
                onClick={importRecipe}
              >
                安全导入
              </button>

              <div
                className="workflow-studio__recipe-divider"
                aria-hidden="true"
              />

              <div className="workflow-studio__recipe-actions">
                <button
                  type="button"
                  disabled={isRunning || !planResult.ok}
                  data-action="export-recipe"
                  onClick={exportRecipe}
                >
                  生成纯配方
                </button>
                <button
                  type="button"
                  disabled={exportDraft === ""}
                  data-action="copy-recipe"
                  onClick={() => void copyExport()}
                >
                  复制
                </button>
              </div>
              <label>
                <span>规范化导出</span>
                <textarea
                  id={exportId}
                  value={exportDraft}
                  readOnly
                  placeholder="生成后可在这里复制…"
                  data-recipe-export
                />
              </label>
            </div>
          </details>
        </aside>
      </div>

      <WorkflowBatchPanel
        key={batchPanelKey}
        plan={plan}
        templateId={activeTemplate?.id}
        disabled={isRunning}
        onBusyChange={setBatchBusy}
      />
    </section>
  );
}

export { WorkflowStudio };

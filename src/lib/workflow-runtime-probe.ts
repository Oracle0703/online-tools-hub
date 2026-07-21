import type { OperationInput } from "../operations/contract";
import type { SerializedWorkflowError } from "../workflows/errors";
import { isWorkflowError } from "../workflows/errors";
import { compileWorkflowCandidate } from "../workflows/planner";
import { exportWorkflowRecipeCanonical } from "../workflows/recipe-codec";
import {
  WorkflowRunner,
  type WorkflowRunnerSnapshot,
} from "../workflows/runner";
import {
  getWorkflowTemplate,
  type WorkflowTemplateId,
} from "../workflows/templates";

const MAX_PENDING_PROBE_RESULTS = 2;
const MAX_PROBE_TEXT_OUTPUT_BYTES = 256 * 1024;

export type WorkflowRuntimeProbeInput =
  | Readonly<{ kind: "text"; text: string }>
  | Readonly<{
      kind: "rgba-image";
      width: number;
      height: number;
      data: Uint8ClampedArray;
    }>;

export type WorkflowRuntimeProbeOutput =
  | Readonly<{
      kind: "text";
      semanticType: string;
      bytes: number;
      text: string;
      truncated: boolean;
    }>
  | Readonly<{
      kind: "binary";
      semanticType: string;
      bytes: number;
      mimeType?: string;
    }>;

export type WorkflowRuntimeProbeResult =
  | Readonly<{ ok: true; output: WorkflowRuntimeProbeOutput }>
  | Readonly<{ ok: false; error: SerializedWorkflowError }>;

export interface WorkflowRuntimeProbeStart {
  readonly runId: string;
  readonly templateId: WorkflowTemplateId;
}

export interface WorkflowRuntimeProbeSnapshot extends WorkflowRunnerSnapshot {
  readonly pendingResultCount: number;
}

/**
 * Narrow browser-only acceptance surface for the hidden production Workflow
 * route. Callers can select one of the six built-in templates, but cannot
 * provide a recipe, module specifier, callback or URL.
 */
export interface WorkflowRuntimeProbe {
  start(
    templateId: WorkflowTemplateId,
    input: WorkflowRuntimeProbeInput,
  ): WorkflowRuntimeProbeStart;
  wait(runId: string): Promise<WorkflowRuntimeProbeResult>;
  cancel(runId: string): boolean;
  clear(): void;
  snapshot(): WorkflowRuntimeProbeSnapshot;
  exportRecipe(templateId: WorkflowTemplateId): string;
}

interface PendingProbeRun {
  cancel: (() => boolean) | null;
  readonly result: Promise<WorkflowRuntimeProbeResult>;
}

type WorkflowRuntimeProbeWindow = Window &
  typeof globalThis & {
    readonly __onlineToolsWorkflowProbe?: WorkflowRuntimeProbe;
  };

const runner = new WorkflowRunner();
const pendingRuns = new Map<string, PendingProbeRun>();

function validateRunId(runId: string): void {
  if (typeof runId !== "string" || runId.length === 0) {
    throw new TypeError("Workflow probe runId must be a non-empty string.");
  }
}

function resolveTemplate(templateId: string) {
  if (typeof templateId !== "string" || templateId.length === 0) {
    throw new TypeError(
      "Workflow probe templateId must be a non-empty string.",
    );
  }
  const template = getWorkflowTemplate(templateId);
  if (template === undefined) {
    throw new RangeError("Workflow probe template was not found.");
  }
  return template;
}

function summarizeFinalOutput(
  finalPayloadId: string,
): WorkflowRuntimeProbeOutput {
  const preview = runner.vault.preview(
    finalPayloadId,
    MAX_PROBE_TEXT_OUTPUT_BYTES,
  );
  if (preview.kind === "text") {
    return Object.freeze({
      kind: "text",
      semanticType: preview.semanticType,
      bytes: preview.bytes,
      text: preview.text,
      truncated: preview.truncated,
    });
  }
  if (preview.kind === "binary") {
    return Object.freeze({
      kind: "binary",
      semanticType: preview.semanticType,
      bytes: preview.bytes,
      ...(preview.mimeType === undefined ? {} : { mimeType: preview.mimeType }),
    });
  }

  throw new TypeError(
    "Workflow template returned an unsupported final payload.",
  );
}

function serializeProbeFailure(error: unknown): SerializedWorkflowError {
  if (isWorkflowError(error)) return error.toJSON();
  return {
    name: "WorkflowError",
    code: "operation-failed",
    message: "The workflow operation failed.",
  };
}

function clearProbe(): void {
  runner.clear();
  pendingRuns.clear();
}

runner.bindPageHide(window);
window.addEventListener("pagehide", () => pendingRuns.clear());

const probe: WorkflowRuntimeProbe = Object.freeze({
  start(
    templateId: WorkflowTemplateId,
    input: WorkflowRuntimeProbeInput,
  ): WorkflowRuntimeProbeStart {
    if (pendingRuns.size >= MAX_PENDING_PROBE_RESULTS) {
      throw new RangeError("Workflow probe has too many unread results.");
    }

    const template = resolveTemplate(templateId);
    const plan = compileWorkflowCandidate(template.recipe);
    const initial = runner.vault.put(
      input as OperationInput,
      template.input.contentType,
    );

    let run;
    try {
      run = runner.start(plan, initial.id);
    } catch (error) {
      runner.vault.delete(initial.id);
      throw error;
    }

    const result = run.promise.then<
      WorkflowRuntimeProbeResult,
      WorkflowRuntimeProbeResult
    >(
      ({ finalPayloadId }) =>
        Object.freeze({
          ok: true,
          output: summarizeFinalOutput(finalPayloadId),
        }),
      (error: unknown) =>
        Object.freeze({ ok: false, error: serializeProbeFailure(error) }),
    );
    const pending: PendingProbeRun = { cancel: run.cancel, result };
    pendingRuns.set(run.runId, pending);
    void result.then(() => {
      pending.cancel = null;
      // The bounded result summary is sufficient for acceptance. Release all
      // original and intermediate payload bodies immediately on settlement.
      runner.clear();
    });

    return Object.freeze({ runId: run.runId, templateId: template.id });
  },

  async wait(runId: string): Promise<WorkflowRuntimeProbeResult> {
    validateRunId(runId);
    const pending = pendingRuns.get(runId);
    if (pending === undefined) {
      throw new RangeError("Workflow probe run was not found.");
    }
    try {
      return await pending.result;
    } finally {
      pendingRuns.delete(runId);
    }
  },

  cancel(runId: string): boolean {
    validateRunId(runId);
    return pendingRuns.get(runId)?.cancel?.() ?? false;
  },

  clear(): void {
    clearProbe();
  },

  snapshot(): WorkflowRuntimeProbeSnapshot {
    return Object.freeze({
      ...runner.snapshot(),
      pendingResultCount: pendingRuns.size,
    });
  },

  exportRecipe(templateId: WorkflowTemplateId): string {
    const template = resolveTemplate(templateId);
    const plan = compileWorkflowCandidate(template.recipe);
    return exportWorkflowRecipeCanonical(plan.recipe);
  },
});

Object.defineProperty(
  window as WorkflowRuntimeProbeWindow,
  "__onlineToolsWorkflowProbe",
  {
    configurable: false,
    enumerable: false,
    writable: false,
    value: probe,
  },
);
document.documentElement.dataset.workflowRuntimeProbe = "ready";
window.dispatchEvent(new Event("workflow-runtime-probe-ready"));

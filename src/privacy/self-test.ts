import { validatePrivacyContentSecurityPolicy } from "../../scripts/privacy-csp-core.mjs";
import { validatePrivacyManifest } from "../../scripts/privacy-manifest-core.mjs";
import type { OperationTask } from "../operations/executor";
import { isOperationError } from "../operations/errors";
import { compileWorkflowCandidate } from "../workflows/planner";
import type { WorkflowRun } from "../workflows/runner";
import { WorkflowRunner } from "../workflows/runner";
import { getWorkflowTemplate } from "../workflows/templates";
import { WorkerOperationExecutor } from "../workflows/worker-executor";
import { privacyManifest } from "./manifest";
import {
  PrivacyObservationAbortedError,
  PrivacyObservationUnavailableError,
  awaitPrivacyObservation,
  capturePrivacyObservableState,
} from "./observation";

export const PRIVACY_SELF_TEST_VERSION = 1 as const;
export const PRIVACY_SELF_TEST_DEFAULT_TIMEOUT_MS = 20_000;
export const PRIVACY_SELF_TEST_MAX_TIMEOUT_MS = 120_000;

export const privacySelfTestCheckIds = [
  "environment",
  "manifest",
  "csp",
  "operation-worker",
  "built-in-workflow",
  "site-resources",
  "origin-state",
  "resource-cleanup",
] as const;

export type PrivacySelfTestCheckId = (typeof privacySelfTestCheckIds)[number];

export const privacySelfTestCodes = [
  "passed",
  "not-run",
  "invalid-options",
  "unsupported-environment",
  "manifest-invalid",
  "csp-invalid",
  "operation-failed",
  "operation-data-observed",
  "workflow-failed",
  "workflow-data-observed",
  "site-resource-violation",
  "origin-state-leak",
  "resources-retained",
  "cancelled",
  "timeout",
  "internal-error",
] as const;

export type PrivacySelfTestCode = (typeof privacySelfTestCodes)[number];
export type PrivacySelfTestReportCode = Exclude<PrivacySelfTestCode, "not-run">;

export interface PrivacySelfTestCheckResult {
  readonly id: PrivacySelfTestCheckId;
  readonly passed: boolean;
  readonly code: PrivacySelfTestCode;
}

export interface PrivacySelfTestReport {
  readonly version: typeof PRIVACY_SELF_TEST_VERSION;
  readonly passed: boolean;
  readonly code: PrivacySelfTestReportCode;
  readonly checks: readonly PrivacySelfTestCheckResult[];
}

export interface PrivacySelfTestOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly baseUrl?: string;
}

type CheckState = Map<PrivacySelfTestCheckId, PrivacySelfTestCheckResult>;
type AbortReason = "cancelled" | "timeout";

class SelfTestAbortError extends Error {
  constructor() {
    super("Privacy self-test was aborted.");
    this.name = "SelfTestAbortError";
  }
}

function check(
  id: PrivacySelfTestCheckId,
  passed: boolean,
  code: PrivacySelfTestCode,
): PrivacySelfTestCheckResult {
  return Object.freeze({ id, passed, code });
}

function report(
  code: PrivacySelfTestReportCode,
  state: CheckState = new Map(),
): PrivacySelfTestReport {
  const checks = Object.freeze(
    privacySelfTestCheckIds.map(
      (id) => state.get(id) ?? check(id, false, "not-run"),
    ),
  );
  return Object.freeze({
    version: PRIVACY_SELF_TEST_VERSION,
    passed: code === "passed" && checks.every((entry) => entry.passed),
    code,
    checks,
  });
}

function mark(
  state: CheckState,
  id: PrivacySelfTestCheckId,
  passed: boolean,
  code: PrivacySelfTestCode,
): void {
  state.set(id, check(id, passed, code));
}

function normalizeBasePath(value: string): string {
  const pathname = value.split(/[?#]/u, 1)[0] ?? "/";
  const normalized = `/${pathname}`.replace(/\/{2,}/gu, "/");
  const stripped = normalized.replace(/^\/+|\/+$/gu, "");
  return stripped ? `/${stripped}/` : "/";
}

function validOptions(options: PrivacySelfTestOptions): boolean {
  const timeoutMs = options.timeoutMs ?? PRIVACY_SELF_TEST_DEFAULT_TIMEOUT_MS;
  return (
    Number.isSafeInteger(timeoutMs) &&
    timeoutMs > 0 &&
    timeoutMs <= PRIVACY_SELF_TEST_MAX_TIMEOUT_MS &&
    (options.baseUrl === undefined || typeof options.baseUrl === "string")
  );
}

function hasBrowserObservationEnvironment(): boolean {
  try {
    return (
      typeof window !== "undefined" &&
      typeof document !== "undefined" &&
      typeof Worker !== "undefined" &&
      typeof crypto?.getRandomValues === "function" &&
      typeof crypto?.subtle?.digest === "function" &&
      typeof TextEncoder !== "undefined" &&
      typeof TextDecoder !== "undefined" &&
      typeof btoa === "function" &&
      typeof performance?.now === "function" &&
      typeof performance?.getEntriesByType === "function" &&
      typeof caches?.keys === "function" &&
      typeof indexedDB?.databases === "function" &&
      localStorage !== undefined &&
      sessionStorage !== undefined
    );
  } catch {
    return false;
  }
}

function cspIsValid(): boolean {
  const policies = [...document.querySelectorAll<HTMLMetaElement>("meta")]
    .filter(
      (meta) =>
        meta.httpEquiv.trim().toLowerCase() === "content-security-policy",
    )
    .map((meta) => meta.content);
  if (policies.length !== 1) return false;
  return validatePrivacyContentSecurityPolicy(
    policies[0] ?? "",
    privacyManifest.enforcement.csp.requiredDirectives,
  ).ok;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new SelfTestAbortError();
}

function createCanary(): string {
  const entropy = new Uint32Array(4);
  crypto.getRandomValues(entropy);
  const token = [...entropy]
    .map((value) => value.toString(16).padStart(8, "0"))
    .join("");
  entropy.fill(0);
  return `OTH_PRIVACY_SELF_TEST_${token}_中文🙂?&`;
}

function utf8Base64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  bytes.fill(0);
  return btoa(binary);
}

function canaryRepresentations(canary: string): string[] {
  const base64 = utf8Base64(canary);
  return [
    canary,
    encodeURI(canary),
    encodeURIComponent(canary),
    base64,
    base64.replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, ""),
  ];
}

async function sha256Hex(value: string, signal: AbortSignal): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  try {
    const digest = await awaitPrivacyObservation(signal, () =>
      crypto.subtle.digest("SHA-256", bytes),
    );
    return [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  } finally {
    bytes.fill(0);
  }
}

function containsRepresentation(
  values: readonly string[],
  representations: readonly string[],
): boolean {
  return values.some((value) =>
    representations.some(
      (representation) =>
        representation.length > 0 && value.includes(representation),
    ),
  );
}

function safeSerialize(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    throw new PrivacyObservationUnavailableError();
  }
}

function resourceUrlsSince(startTime: number): string[] {
  return performance
    .getEntriesByType("resource")
    .filter((entry) => entry.startTime >= startTime)
    .map((entry) => entry.name);
}

function resourcesAreAllowed(
  urls: readonly string[],
  basePath: string,
): boolean {
  return urls.every((value) => {
    try {
      const url = new URL(value, window.location.href);
      return (
        (url.protocol === "https:" || url.protocol === "http:") &&
        url.origin === window.location.origin &&
        url.pathname.startsWith(basePath) &&
        url.search === ""
      );
    } catch {
      return false;
    }
  });
}

function serializedOperationFailure(error: unknown): string {
  return safeSerialize(
    isOperationError(error)
      ? error.toJSON()
      : { name: "OperationError", code: "internal-error" },
  );
}

function resourcesReleased(
  runner: WorkflowRunner,
  executor: WorkerOperationExecutor,
): boolean {
  const workflow = runner.snapshot();
  const operation = executor.snapshot();
  return (
    workflow.activeRunCount === 0 &&
    workflow.vault.entries === 0 &&
    workflow.vault.bytes === 0 &&
    workflow.vault.objectUrls === 0 &&
    operation.activeTaskCount === 0 &&
    operation.activeWorkerCount === 0 &&
    operation.activeMemoryBytes === 0 &&
    operation.globalActiveTaskCount === 0 &&
    operation.globalActiveWorkerCount === 0
  );
}

/**
 * Runs a fixed synthetic canary through the real Worker Operation and one
 * built-in Workflow. The returned report contains only booleans and stable
 * codes; the random canary, derived output and browser state never leave this
 * function. A passing report describes only this site's observed current run.
 */
export async function runPrivacySelfTest(
  options: PrivacySelfTestOptions = {},
): Promise<PrivacySelfTestReport> {
  const state: CheckState = new Map();
  if (!validOptions(options)) return report("invalid-options", state);
  if (options.signal?.aborted) return report("cancelled", state);
  if (!hasBrowserObservationEnvironment()) {
    mark(state, "environment", false, "unsupported-environment");
    return report("unsupported-environment", state);
  }
  mark(state, "environment", true, "passed");

  const manifestValidation = validatePrivacyManifest(privacyManifest);
  if (!manifestValidation.ok) {
    mark(state, "manifest", false, "manifest-invalid");
    return report("manifest-invalid", state);
  }
  mark(state, "manifest", true, "passed");

  if (!cspIsValid()) {
    mark(state, "csp", false, "csp-invalid");
    return report("csp-invalid", state);
  }
  mark(state, "csp", true, "passed");

  const timeoutMs = options.timeoutMs ?? PRIVACY_SELF_TEST_DEFAULT_TIMEOUT_MS;
  const basePath = normalizeBasePath(
    options.baseUrl ?? import.meta.env.BASE_URL,
  );
  const controller = new AbortController();
  let abortReason: AbortReason | null = null;
  let activeTask: OperationTask | null = null;
  let activeRun: WorkflowRun | null = null;
  let executor: WorkerOperationExecutor | null = null;
  let runner: WorkflowRunner | null = null;
  const representations: string[] = [];
  const policyViolations: string[] = [];

  const abort = (reason: AbortReason) => {
    if (controller.signal.aborted) return;
    abortReason = reason;
    controller.abort();
  };
  const externalAbort = () => abort("cancelled");
  const pageHide = () => abort("cancelled");
  const internalAbort = () => {
    activeTask?.cancel();
    activeRun?.cancel();
    runner?.clear();
  };
  const policyViolation = (event: SecurityPolicyViolationEvent) => {
    policyViolations.push(
      `${event.effectiveDirective}:${event.blockedURI}:${event.disposition}`,
    );
  };

  options.signal?.addEventListener("abort", externalAbort, { once: true });
  if (options.signal?.aborted) abort("cancelled");
  window.addEventListener("pagehide", pageHide, { once: true });
  controller.signal.addEventListener("abort", internalAbort, { once: true });
  document.addEventListener("securitypolicyviolation", policyViolation);
  const timeoutHandle = window.setTimeout(() => abort("timeout"), timeoutMs);

  try {
    executor = new WorkerOperationExecutor({
      maxActiveTasks: 1,
      maxActiveWorkers: 1,
    });
    runner = new WorkflowRunner({
      executor,
      disposeExecutor: false,
    });

    const resourceStart = performance.now();
    const canary = createCanary();
    representations.push(...canaryRepresentations(canary));
    representations.push(await sha256Hex(canary, controller.signal));
    throwIfAborted(controller.signal);

    activeTask = executor.execute(
      {
        operationId: "json.transform",
        input: {
          kind: "text",
          text: `{"sentinel":${JSON.stringify(canary)},"broken":}`,
        },
        options: { mode: "format", indent: 2 },
      },
      { signal: controller.signal, timeoutMs },
    );
    if (activeTask.location !== "worker") {
      mark(state, "operation-worker", false, "operation-failed");
      return report("operation-failed", state);
    }
    let operationFailure = "";
    try {
      await awaitPrivacyObservation(
        controller.signal,
        () => activeTask!.promise,
        () => activeTask?.cancel(),
      );
      mark(state, "operation-worker", false, "operation-failed");
      return report("operation-failed", state);
    } catch (error) {
      throwIfAborted(controller.signal);
      operationFailure = serializedOperationFailure(error);
      if (!isOperationError(error)) {
        mark(state, "operation-worker", false, "operation-failed");
        return report("operation-failed", state);
      }
    } finally {
      activeTask = null;
    }
    if (containsRepresentation([operationFailure], representations)) {
      mark(state, "operation-worker", false, "operation-data-observed");
      return report("operation-data-observed", state);
    }
    mark(state, "operation-worker", true, "passed");

    const workflow = getWorkflowTemplate("csv-api-fixture-sha256");
    if (workflow === undefined) {
      mark(state, "built-in-workflow", false, "workflow-failed");
      return report("workflow-failed", state);
    }
    const plan = compileWorkflowCandidate(workflow.recipe);
    const initial = runner.vault.put(
      { kind: "text", text: `name,value\nsynthetic,${canary}` },
      workflow.input.contentType,
    );
    activeRun = runner.start(plan, initial.id);
    let workflowResult;
    try {
      workflowResult = await awaitPrivacyObservation(
        controller.signal,
        () => activeRun!.promise,
        () => activeRun?.cancel(),
      );
    } catch (error) {
      throwIfAborted(controller.signal);
      const failure =
        error instanceof Error
          ? `${error.name}:${error.message}:${safeSerialize(error)}`
          : safeSerialize(error);
      if (containsRepresentation([failure], representations)) {
        mark(state, "built-in-workflow", false, "workflow-data-observed");
        return report("workflow-data-observed", state);
      }
      mark(state, "built-in-workflow", false, "workflow-failed");
      return report("workflow-failed", state);
    }
    throwIfAborted(controller.signal);
    activeRun = null;
    const output = runner.vault.preview(workflowResult.finalPayloadId, 256);
    if (
      output.kind !== "text" ||
      output.truncated ||
      !/^[a-f0-9]{64}$/u.test(output.text)
    ) {
      mark(state, "built-in-workflow", false, "workflow-failed");
      return report("workflow-failed", state);
    }
    representations.push(output.text);
    runner.clear();
    mark(state, "built-in-workflow", true, "passed");

    const observable = await capturePrivacyObservableState({
      basePath,
      signal: controller.signal,
      representations,
    });
    const resourceUrls = resourceUrlsSince(resourceStart);
    const resourceEvidence = [...resourceUrls, ...policyViolations];
    const siteResourcesPassed =
      observable.cacheMetadataValid &&
      policyViolations.length === 0 &&
      resourcesAreAllowed(resourceUrls, basePath) &&
      !containsRepresentation(resourceEvidence, representations);
    mark(
      state,
      "site-resources",
      siteResourcesPassed,
      siteResourcesPassed ? "passed" : "site-resource-violation",
    );
    if (!siteResourcesPassed) {
      return report("site-resource-violation", state);
    }

    const originStatePassed =
      !observable.cacheResponseContainsSensitiveData &&
      !containsRepresentation([observable.serialized], representations);
    mark(
      state,
      "origin-state",
      originStatePassed,
      originStatePassed ? "passed" : "origin-state-leak",
    );
    if (!originStatePassed) return report("origin-state-leak", state);

    await Promise.resolve();
    const cleanupPassed = resourcesReleased(runner, executor);
    mark(
      state,
      "resource-cleanup",
      cleanupPassed,
      cleanupPassed ? "passed" : "resources-retained",
    );
    return report(cleanupPassed ? "passed" : "resources-retained", state);
  } catch (error) {
    if (abortReason === "timeout") return report("timeout", state);
    if (
      abortReason === "cancelled" ||
      error instanceof SelfTestAbortError ||
      error instanceof PrivacyObservationAbortedError
    ) {
      return report("cancelled", state);
    }
    if (error instanceof PrivacyObservationUnavailableError) {
      mark(state, "origin-state", false, "unsupported-environment");
      return report("unsupported-environment", state);
    }
    return report("internal-error", state);
  } finally {
    window.clearTimeout(timeoutHandle);
    options.signal?.removeEventListener("abort", externalAbort);
    window.removeEventListener("pagehide", pageHide);
    controller.signal.removeEventListener("abort", internalAbort);
    document.removeEventListener("securitypolicyviolation", policyViolation);
    activeTask?.cancel();
    activeRun?.cancel();
    runner?.clear();
    runner?.dispose();
    executor?.dispose();
    policyViolations.length = 0;
    representations.fill("");
    representations.length = 0;
  }
}

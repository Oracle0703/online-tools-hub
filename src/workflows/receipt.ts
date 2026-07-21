import type { WorkflowRecipeV1 } from "./contract";
import { workflowErrorCodes, type WorkflowErrorCode } from "./errors";
import { normalizeWorkflowRecipe } from "./recipe-codec";

export const WORKFLOW_PRIVACY_RECEIPT_FORMAT =
  "online-tools-hub/privacy-receipt" as const;
export const WORKFLOW_PRIVACY_RECEIPT_VERSION = 1 as const;

export const workflowReceiptStatuses = [
  "not-started",
  "running",
  "succeeded",
  "completed-with-errors",
  "cancelled",
] as const;

export type WorkflowReceiptStatus = (typeof workflowReceiptStatuses)[number];

export const workflowReceiptItemStatuses = [
  "pending",
  "running",
  "succeeded",
  "failed",
  "cancelled",
] as const;

export type WorkflowReceiptItemStatus =
  (typeof workflowReceiptItemStatuses)[number];

export const workflowReceiptBatchErrorCodes = [
  "input-failed",
  "item-size-limit",
  "total-size-limit",
  "execution-failed",
] as const;

export type WorkflowReceiptBatchErrorCode =
  (typeof workflowReceiptBatchErrorCodes)[number];
export type WorkflowReceiptItemErrorCode =
  WorkflowErrorCode | WorkflowReceiptBatchErrorCode;

const RECEIPT_ITEM_ERROR_CODES: ReadonlySet<string> = new Set([
  ...workflowErrorCodes,
  ...workflowReceiptBatchErrorCodes,
]);
const RECEIPT_ITEM_STATUSES: ReadonlySet<string> = new Set(
  workflowReceiptItemStatuses,
);
const RECEIPT_SOURCE_KEYS = new Set([
  "recipe",
  "startedAt",
  "completedAt",
  "items",
]);
const RECEIPT_ITEM_KEYS = new Set(["status", "errorCode"]);

export interface WorkflowReceiptSourceItem {
  readonly status: WorkflowReceiptItemStatus;
  readonly errorCode?: WorkflowReceiptItemErrorCode;
}

/**
 * Receipt-safe input. It deliberately has no item ID, Vault ID, file label,
 * payload fragment or digest field.
 */
export interface WorkflowReceiptSource {
  readonly recipe: unknown;
  readonly startedAt: number | null;
  readonly completedAt: number | null;
  readonly items: readonly WorkflowReceiptSourceItem[];
}

export interface WorkflowPrivacyReceiptSummary {
  readonly total: number;
  readonly pending: number;
  readonly running: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly cancelled: number;
}

export interface WorkflowPrivacyReceiptV1 {
  readonly format: typeof WORKFLOW_PRIVACY_RECEIPT_FORMAT;
  readonly version: typeof WORKFLOW_PRIVACY_RECEIPT_VERSION;
  readonly localOnly: true;
  readonly capabilities: Readonly<{
    processing: "local-only";
    network: "forbidden";
    persistence: "forbidden";
  }>;
  readonly recipe: WorkflowRecipeV1;
  readonly operationIds: readonly string[];
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly status: WorkflowReceiptStatus;
  readonly summary: WorkflowPrivacyReceiptSummary;
  readonly items: readonly Readonly<{
    status: WorkflowReceiptItemStatus;
    errorCode?: WorkflowReceiptItemErrorCode;
  }>[];
}

function timestampToIso(value: number | null, label: string): string | null {
  if (value === null) return null;
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 8_640_000_000_000_000
  ) {
    throw new RangeError(`${label} must be a valid non-negative epoch time.`);
  }
  return new Date(value).toISOString();
}

function normalizeItems(
  values: readonly WorkflowReceiptSourceItem[],
): readonly Readonly<{
  status: WorkflowReceiptItemStatus;
  errorCode?: WorkflowReceiptItemErrorCode;
}>[] {
  if (
    !Array.isArray(values) ||
    Object.getPrototypeOf(values) !== Array.prototype ||
    values.length > 64
  ) {
    throw new TypeError("Receipt items must be a bounded array.");
  }
  const keys = Reflect.ownKeys(values);
  if (keys.length !== values.length + 1 || !keys.includes("length")) {
    throw new TypeError("Receipt items must be a dense data array.");
  }
  return Object.freeze(
    Array.from({ length: values.length }, (_, index) => {
      const itemDescriptor = Object.getOwnPropertyDescriptor(
        values,
        String(index),
      );
      if (
        itemDescriptor === undefined ||
        !itemDescriptor.enumerable ||
        !("value" in itemDescriptor)
      ) {
        throw new TypeError("Receipt items must be a dense data array.");
      }
      const value = itemDescriptor.value as unknown;
      if (
        value === null ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        (Object.getPrototypeOf(value) !== Object.prototype &&
          Object.getPrototypeOf(value) !== null)
      ) {
        throw new TypeError("Receipt item status is invalid.");
      }
      const record = Object.create(null) as Record<string, unknown>;
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== "string" || !RECEIPT_ITEM_KEYS.has(key)) {
          throw new TypeError("Receipt item contains an unsupported field.");
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (
          descriptor === undefined ||
          !descriptor.enumerable ||
          !("value" in descriptor)
        ) {
          throw new TypeError("Receipt item must contain only data fields.");
        }
        record[key] = descriptor.value;
      }
      const status = record.status;
      if (typeof status !== "string" || !RECEIPT_ITEM_STATUSES.has(status)) {
        throw new TypeError("Receipt item status is invalid.");
      }
      const errorCode = record.errorCode;
      if (
        errorCode !== undefined &&
        (typeof errorCode !== "string" ||
          !RECEIPT_ITEM_ERROR_CODES.has(errorCode))
      ) {
        throw new TypeError("Receipt item error code is invalid.");
      }
      return Object.freeze({
        status: status as WorkflowReceiptItemStatus,
        ...(errorCode === undefined
          ? {}
          : { errorCode: errorCode as WorkflowReceiptItemErrorCode }),
      });
    }),
  );
}

function readReceiptSource(value: unknown): {
  readonly recipe: unknown;
  readonly startedAt: unknown;
  readonly completedAt: unknown;
  readonly items: unknown;
} {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new TypeError("Receipt source must be a plain data object.");
  }
  const record = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !RECEIPT_SOURCE_KEYS.has(key)) {
      throw new TypeError("Receipt source contains an unsupported field.");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      throw new TypeError("Receipt source must contain only data fields.");
    }
    record[key] = descriptor.value;
  }
  if (
    !Object.prototype.hasOwnProperty.call(record, "recipe") ||
    !Object.prototype.hasOwnProperty.call(record, "startedAt") ||
    !Object.prototype.hasOwnProperty.call(record, "completedAt") ||
    !Object.prototype.hasOwnProperty.call(record, "items")
  ) {
    throw new TypeError("Receipt source is missing a required field.");
  }
  return {
    recipe: record.recipe,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    items: record.items,
  };
}

function summarize(
  items: readonly WorkflowReceiptSourceItem[],
): WorkflowPrivacyReceiptSummary {
  const counts = {
    total: items.length,
    pending: 0,
    running: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
  };
  for (const item of items) counts[item.status] += 1;
  return Object.freeze(counts);
}

function deriveStatus(
  summary: WorkflowPrivacyReceiptSummary,
): WorkflowReceiptStatus {
  if (summary.total === 0 || summary.pending === summary.total) {
    return "not-started";
  }
  if (summary.running > 0 || summary.pending > 0) return "running";
  if (summary.succeeded === summary.total) return "succeeded";
  if (summary.cancelled === summary.total) return "cancelled";
  return "completed-with-errors";
}

/** Builds a deeply frozen, payload-free proof of local workflow processing. */
export function createWorkflowPrivacyReceipt(
  source: WorkflowReceiptSource,
): WorkflowPrivacyReceiptV1 {
  const inspected = readReceiptSource(source);
  const recipe = normalizeWorkflowRecipe(inspected.recipe);
  const startedAt = timestampToIso(
    inspected.startedAt as number | null,
    "startedAt",
  );
  const completedAt = timestampToIso(
    inspected.completedAt as number | null,
    "completedAt",
  );
  if (
    inspected.startedAt !== null &&
    inspected.completedAt !== null &&
    (inspected.completedAt as number) < (inspected.startedAt as number)
  ) {
    throw new RangeError("completedAt must not precede startedAt.");
  }
  const items = normalizeItems(
    inspected.items as readonly WorkflowReceiptSourceItem[],
  );
  const summary = summarize(items);

  return Object.freeze({
    format: WORKFLOW_PRIVACY_RECEIPT_FORMAT,
    version: WORKFLOW_PRIVACY_RECEIPT_VERSION,
    localOnly: true,
    capabilities: Object.freeze({
      processing: "local-only",
      network: "forbidden",
      persistence: "forbidden",
    }),
    recipe,
    operationIds: Object.freeze(recipe.steps.map((step) => step.operationId)),
    startedAt,
    completedAt,
    status: deriveStatus(summary),
    summary,
    items,
  });
}

/** The construction order above is the canonical wire order for v1 receipts. */
export function exportWorkflowPrivacyReceiptCanonical(
  source: WorkflowReceiptSource,
): string {
  return JSON.stringify(createWorkflowPrivacyReceipt(source));
}

import type { OperationOutput } from "../operations/contract";
import { isWorkflowError } from "./errors";
import {
  type PayloadId,
  PayloadVault,
  PayloadVaultError,
  type VaultPayload,
} from "./payload-vault";
import type { WorkflowPlan } from "./planner";
import type {
  WorkflowReceiptItemErrorCode,
  WorkflowReceiptItemStatus,
  WorkflowReceiptSource,
} from "./receipt";
import { WorkflowRunner } from "./runner";

export const MAX_WORKFLOW_BATCH_ITEMS = 64;
export const MAX_WORKFLOW_BATCH_ITEM_BYTES = 64 * 1024 * 1024;
export const MAX_WORKFLOW_BATCH_TOTAL_BYTES = 256 * 1024 * 1024;

export const workflowBatchErrorCodes = [
  "invalid-item",
  "item-limit",
  "item-size-limit",
  "total-size-limit",
  "unknown-item",
  "not-retryable",
  "result-unavailable",
  "run-conflict",
  "disposed",
] as const;

export type WorkflowBatchErrorCode = (typeof workflowBatchErrorCodes)[number];

const BATCH_ERROR_MESSAGES: Readonly<Record<WorkflowBatchErrorCode, string>> =
  Object.freeze({
    "invalid-item": "The batch item is invalid.",
    "item-limit": "The workflow batch has too many items.",
    "item-size-limit": "The workflow batch item exceeds the size limit.",
    "total-size-limit": "The workflow batch exceeds the total size limit.",
    "unknown-item": "The workflow batch item does not exist.",
    "not-retryable": "The workflow batch item cannot be retried.",
    "result-unavailable": "The workflow batch result is unavailable.",
    "run-conflict": "The workflow batch is already active.",
    disposed: "The workflow batch has been disposed.",
  });

export class WorkflowBatchError extends Error {
  readonly code: WorkflowBatchErrorCode;

  constructor(code: WorkflowBatchErrorCode) {
    super(BATCH_ERROR_MESSAGES[code]);
    this.name = "WorkflowBatchError";
    this.code = code;
  }
}

export type WorkflowBatchStatus =
  "idle" | "running" | "completed" | "cancelled";

export type WorkflowBatchItemStatus = WorkflowReceiptItemStatus;
export type WorkflowBatchItemErrorCode = WorkflowReceiptItemErrorCode;

export interface WorkflowBatchInput {
  readonly payload: VaultPayload;
  readonly semanticType: string;
}

export interface WorkflowBatchEnqueueRequest {
  /** Source-size admission hint; no source body is retained by the queue. */
  readonly bytes: number;
  /** Invoked only when this item reaches the front of the serial queue. */
  readonly inputFactory: (
    signal: AbortSignal,
  ) => WorkflowBatchInput | Promise<WorkflowBatchInput>;
}

export interface WorkflowBatchEnqueueResult {
  readonly itemId: string;
  readonly bytes: number;
}

export interface WorkflowBatchItemSnapshot {
  readonly itemId: string;
  readonly status: WorkflowBatchItemStatus;
  readonly bytes: number;
  readonly errorCode?: WorkflowBatchItemErrorCode;
}

export interface WorkflowBatchSnapshot {
  readonly status: WorkflowBatchStatus;
  readonly disposed: boolean;
  readonly items: readonly WorkflowBatchItemSnapshot[];
}

export interface WorkflowBatchResultBytes {
  readonly data: ArrayBuffer;
  readonly contentType: string;
}

export interface WorkflowBatchVaultContext {
  readonly itemId: string;
  readonly maxBytes: number;
}

export interface WorkflowBatchRunnerContext {
  readonly itemId: string;
  readonly plan: WorkflowPlan;
  readonly vault: PayloadVault;
  readonly maxResidentBytes: number;
}

export interface WorkflowBatchQueueOptions {
  /** Limits may be lowered, but never raised above reviewed v1 bounds. */
  readonly maxItems?: number;
  readonly maxItemBytes?: number;
  readonly maxTotalBytes?: number;
  readonly itemIdFactory?: () => string;
  readonly now?: () => number;
  readonly vaultFactory?: (context: WorkflowBatchVaultContext) => PayloadVault;
  readonly runnerFactory?: (
    context: WorkflowBatchRunnerContext,
  ) => WorkflowRunner;
  readonly createObjectUrl?: (blob: Blob) => string;
  readonly revokeObjectUrl?: (url: string) => void;
}

interface MutableBatchItem {
  readonly itemId: string;
  readonly admittedBytes: number;
  status: WorkflowBatchItemStatus;
  bytes: number;
  errorCode?: WorkflowBatchItemErrorCode;
  inputFactory: WorkflowBatchEnqueueRequest["inputFactory"] | null;
  vault: PayloadVault | null;
  resultId: PayloadId | null;
  runner: WorkflowRunner | null;
  abortController: AbortController | null;
  generation: number;
}

const ITEM_ID_PATTERN = /^[A-Za-z0-9_-]{8,256}$/u;

function defaultItemIdFactory(): string {
  if (typeof globalThis.crypto?.randomUUID !== "function") {
    throw new WorkflowBatchError("invalid-item");
  }
  return globalThis.crypto.randomUUID();
}

function assertBoundedLimit(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > fallback) {
    throw new RangeError(`${name} must be a positive bounded safe integer.`);
  }
  return resolved;
}

function assertTimestamp(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 8_640_000_000_000_000
  ) {
    throw new TypeError("now must return a valid non-negative epoch time.");
  }
  return value;
}

function readInput(value: unknown): WorkflowBatchInput {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkflowBatchError("invalid-item");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new WorkflowBatchError("invalid-item");
  }
  const allowed = new Set(["payload", "semanticType"]);
  const record = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new WorkflowBatchError("invalid-item");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      throw new WorkflowBatchError("invalid-item");
    }
    record[key] = descriptor.value;
  }
  if (
    !Object.prototype.hasOwnProperty.call(record, "payload") ||
    typeof record.semanticType !== "string"
  ) {
    throw new WorkflowBatchError("invalid-item");
  }
  return {
    payload: record.payload as VaultPayload,
    semanticType: record.semanticType,
  };
}

function freezeItemSnapshot(item: MutableBatchItem): WorkflowBatchItemSnapshot {
  return Object.freeze({
    itemId: item.itemId,
    status: item.status,
    bytes: item.bytes,
    ...(item.errorCode === undefined ? {} : { errorCode: item.errorCode }),
  });
}

function mapWorkflowFailure(error: unknown): WorkflowBatchItemErrorCode {
  if (isWorkflowError(error)) return error.code;
  return "execution-failed";
}

/**
 * Privacy-first, serial workflow batch coordinator. Input bodies are produced
 * just in time and live only in one active Payload Vault at a time.
 */
export class WorkflowBatchQueue {
  readonly #plan: WorkflowPlan;
  readonly #maxItems: number;
  readonly #maxItemBytes: number;
  readonly #maxTotalBytes: number;
  readonly #itemIdFactory: () => string;
  readonly #now: () => number;
  readonly #vaultFactory: (context: WorkflowBatchVaultContext) => PayloadVault;
  readonly #runnerFactory: (
    context: WorkflowBatchRunnerContext,
  ) => WorkflowRunner;
  readonly #createObjectUrl: (blob: Blob) => string;
  readonly #items: MutableBatchItem[] = [];
  #status: WorkflowBatchStatus = "idle";
  #disposed = false;
  #generation = 0;
  #startedAt: number | null = null;
  #completedAt: number | null = null;
  #activePromise: Promise<WorkflowBatchSnapshot> | null = null;

  constructor(plan: WorkflowPlan, options: WorkflowBatchQueueOptions = {}) {
    this.#plan = plan;
    this.#maxItems = assertBoundedLimit(
      options.maxItems,
      MAX_WORKFLOW_BATCH_ITEMS,
      "maxItems",
    );
    this.#maxItemBytes = assertBoundedLimit(
      options.maxItemBytes,
      MAX_WORKFLOW_BATCH_ITEM_BYTES,
      "maxItemBytes",
    );
    this.#maxTotalBytes = assertBoundedLimit(
      options.maxTotalBytes,
      MAX_WORKFLOW_BATCH_TOTAL_BYTES,
      "maxTotalBytes",
    );
    this.#itemIdFactory = options.itemIdFactory ?? defaultItemIdFactory;
    this.#now = options.now ?? Date.now;
    const revokeObjectUrl =
      options.revokeObjectUrl ??
      ((url: string) => {
        if (typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(url);
      });
    this.#vaultFactory =
      options.vaultFactory ??
      ((context) =>
        new PayloadVault({
          maxBytes: context.maxBytes,
          revokeObjectUrl,
        }));
    this.#runnerFactory =
      options.runnerFactory ??
      ((context) =>
        new WorkflowRunner({
          vault: context.vault,
          maxResidentBytes: context.maxResidentBytes,
        }));
    this.#createObjectUrl =
      options.createObjectUrl ??
      ((blob) => {
        if (typeof URL.createObjectURL !== "function") {
          throw new WorkflowBatchError("result-unavailable");
        }
        return URL.createObjectURL(blob);
      });
  }

  enqueue(request: WorkflowBatchEnqueueRequest): WorkflowBatchEnqueueResult {
    this.#assertActive();
    if (this.#activePromise !== null) {
      throw new WorkflowBatchError("run-conflict");
    }
    if (this.#items.length >= this.#maxItems) {
      throw new WorkflowBatchError("item-limit");
    }
    if (
      request === null ||
      typeof request !== "object" ||
      !Number.isSafeInteger(request.bytes) ||
      request.bytes < 0 ||
      typeof request.inputFactory !== "function"
    ) {
      throw new WorkflowBatchError("invalid-item");
    }
    if (request.bytes > this.#maxItemBytes) {
      throw new WorkflowBatchError("item-size-limit");
    }
    if (this.#reservedBytes() + request.bytes > this.#maxTotalBytes) {
      throw new WorkflowBatchError("total-size-limit");
    }

    const itemId = this.#createItemId();
    this.#items.push({
      itemId,
      admittedBytes: request.bytes,
      status: "pending",
      bytes: request.bytes,
      inputFactory: request.inputFactory,
      vault: null,
      resultId: null,
      runner: null,
      abortController: null,
      generation: 0,
    });
    this.#status = "idle";
    this.#completedAt = null;
    return Object.freeze({ itemId, bytes: request.bytes });
  }

  start(): Promise<WorkflowBatchSnapshot> {
    this.#assertActive();
    if (this.#activePromise !== null) return this.#activePromise;
    if (!this.#items.some((item) => item.status === "pending")) {
      return Promise.resolve(this.snapshot());
    }

    this.#status = "running";
    this.#startedAt ??= this.#readNow();
    this.#completedAt = null;
    this.#generation += 1;
    const generation = this.#generation;
    const promise = this.#process(generation);
    this.#activePromise = promise;
    void promise.finally(() => {
      if (this.#activePromise === promise) this.#activePromise = null;
    });
    return promise;
  }

  async retry(itemId: string): Promise<WorkflowBatchItemSnapshot> {
    this.#assertActive();
    const item = this.#getItem(itemId);
    if (item.status !== "failed" || item.inputFactory === null) {
      throw new WorkflowBatchError("not-retryable");
    }
    item.status = "pending";
    item.errorCode = undefined;
    item.bytes = item.admittedBytes;
    this.#completedAt = null;
    await this.start();
    return freezeItemSnapshot(item);
  }

  cancel(itemId?: string): boolean {
    if (this.#disposed) return false;
    if (itemId !== undefined) {
      const item = this.#getItem(itemId);
      if (
        item.status !== "pending" &&
        item.status !== "running" &&
        item.status !== "failed"
      ) {
        return false;
      }
      this.#cancelItem(item);
      return true;
    }

    const cancellable = this.#items.some(
      (item) =>
        item.status === "pending" ||
        item.status === "running" ||
        item.status === "failed",
    );
    if (!cancellable) return false;
    this.#generation += 1;
    for (const item of this.#items) {
      if (
        item.status === "pending" ||
        item.status === "running" ||
        item.status === "failed"
      ) {
        item.status = "cancelled";
        item.errorCode = "cancelled";
      }
      this.#releaseItem(item, true);
    }
    this.#status = "cancelled";
    this.#completedAt = this.#readNow();
    return true;
  }

  clear(): void {
    this.#generation += 1;
    for (const item of this.#items) this.#releaseItem(item, true);
    this.#items.length = 0;
    this.#status = "idle";
    this.#startedAt = null;
    this.#completedAt = null;
    this.#activePromise = null;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.clear();
    this.#disposed = true;
  }

  snapshot(): WorkflowBatchSnapshot {
    return Object.freeze({
      status: this.#status,
      disposed: this.#disposed,
      items: Object.freeze(this.#items.map(freezeItemSnapshot)),
    });
  }

  materializeResult(itemId: string): OperationOutput {
    this.#assertActive();
    const item = this.#getItem(itemId);
    if (
      item.status !== "succeeded" ||
      item.vault === null ||
      item.resultId === null
    ) {
      throw new WorkflowBatchError("result-unavailable");
    }
    const payload = item.vault.materialize(item.resultId);
    if (payload.kind !== "text" && payload.kind !== "binary") {
      throw new WorkflowBatchError("result-unavailable");
    }
    return payload;
  }

  resultBytes(itemId: string): WorkflowBatchResultBytes {
    const item = this.#getItem(itemId);
    const payload = this.materializeResult(itemId);
    const metadata = item.vault!.metadata(item.resultId!);
    const data =
      payload.kind === "text"
        ? new TextEncoder().encode(payload.text).slice().buffer
        : payload.data.slice(0);
    return Object.freeze({ data, contentType: metadata.semanticType });
  }

  createResultObjectUrl(itemId: string): string {
    const item = this.#getItem(itemId);
    const result = this.resultBytes(itemId);
    const url = this.#createObjectUrl(
      new Blob([result.data], { type: result.contentType }),
    );
    if (typeof url !== "string" || !url.startsWith("blob:")) {
      throw new WorkflowBatchError("result-unavailable");
    }
    item.vault!.registerObjectUrl(url, item.resultId!);
    return url;
  }

  receiptSource(): WorkflowReceiptSource {
    return Object.freeze({
      recipe: this.#plan.recipe,
      startedAt: this.#startedAt,
      completedAt: this.#completedAt,
      items: Object.freeze(
        this.#items.map((item) =>
          Object.freeze({
            status: item.status,
            ...(item.errorCode === undefined
              ? {}
              : { errorCode: item.errorCode }),
          }),
        ),
      ),
    });
  }

  async #process(generation: number): Promise<WorkflowBatchSnapshot> {
    while (generation === this.#generation) {
      const item = this.#items.find(
        (candidate) => candidate.status === "pending",
      );
      if (item === undefined) break;
      await this.#executeItem(item, generation);
    }
    if (generation === this.#generation) {
      this.#status = "completed";
      this.#completedAt = this.#readNow();
    }
    return this.snapshot();
  }

  async #executeItem(
    item: MutableBatchItem,
    batchGeneration: number,
  ): Promise<void> {
    const inputFactory = item.inputFactory;
    if (inputFactory === null) {
      item.status = "failed";
      item.errorCode = "input-failed";
      return;
    }
    item.generation += 1;
    const itemGeneration = item.generation;
    const abortController = new AbortController();
    item.abortController = abortController;
    item.status = "running";
    item.errorCode = undefined;

    let input: WorkflowBatchInput;
    try {
      input = readInput(await inputFactory(abortController.signal));
    } catch {
      if (!this.#isCurrent(item, itemGeneration, batchGeneration)) return;
      item.abortController = null;
      item.status = abortController.signal.aborted ? "cancelled" : "failed";
      item.errorCode = abortController.signal.aborted
        ? "cancelled"
        : "input-failed";
      if (abortController.signal.aborted) {
        item.inputFactory = null;
        item.bytes = 0;
      }
      return;
    }
    if (!this.#isCurrent(item, itemGeneration, batchGeneration)) return;

    const otherReservedBytes = this.#reservedBytes(item);
    const availableBytes = Math.min(
      this.#maxItemBytes,
      this.#maxTotalBytes - otherReservedBytes,
    );
    if (availableBytes <= 0) {
      item.status = "failed";
      item.errorCode = "total-size-limit";
      item.abortController = null;
      return;
    }

    let vault: PayloadVault;
    let initialPayloadId: PayloadId;
    try {
      vault = this.#createVault(item.itemId, availableBytes);
      const handle = vault.put(input.payload, input.semanticType);
      initialPayloadId = handle.id;
      item.vault = vault;
      item.bytes = handle.bytes;
    } catch (error) {
      if (!this.#isCurrent(item, itemGeneration, batchGeneration)) return;
      item.vault?.dispose();
      item.vault = null;
      item.status = "failed";
      item.errorCode =
        error instanceof WorkflowBatchError
          ? "execution-failed"
          : error instanceof PayloadVaultError &&
              error.code === "memory-budget" &&
              availableBytes < this.#maxItemBytes
            ? "total-size-limit"
            : "item-size-limit";
      item.abortController = null;
      item.bytes = item.admittedBytes;
      return;
    }

    const maxResidentBytes = availableBytes + this.#plan.maxWorkingMemoryBytes;
    try {
      const runner = this.#runnerFactory({
        itemId: item.itemId,
        plan: this.#plan,
        vault,
        maxResidentBytes,
      });
      if (runner.vault !== vault) {
        runner.dispose();
        throw new WorkflowBatchError("invalid-item");
      }
      item.runner = runner;
      const result = await runner.start(this.#plan, initialPayloadId).promise;
      if (!this.#isCurrent(item, itemGeneration, batchGeneration)) return;
      const metadata = vault.metadata(result.finalPayloadId);
      const output = vault.materialize(result.finalPayloadId);
      if (output.kind !== "text" && output.kind !== "binary") {
        throw new WorkflowBatchError("result-unavailable");
      }
      runner.dispose();
      item.runner = null;
      item.vault = null;

      const retainedVault = this.#createVault(
        item.itemId,
        Math.max(1, availableBytes),
      );
      const retained = retainedVault.put(output, metadata.semanticType);
      item.vault = retainedVault;
      item.resultId = retained.id;
      item.status = "succeeded";
      item.errorCode = undefined;
      item.bytes = retained.bytes;
      item.inputFactory = null;
      item.abortController = null;
    } catch (error) {
      if (!this.#isCurrent(item, itemGeneration, batchGeneration)) return;
      item.runner?.dispose();
      item.runner = null;
      item.vault?.dispose();
      item.vault = null;
      item.resultId = null;
      item.abortController = null;
      const errorCode = mapWorkflowFailure(error);
      item.status = errorCode === "cancelled" ? "cancelled" : "failed";
      item.errorCode = errorCode;
      item.bytes = errorCode === "cancelled" ? 0 : item.admittedBytes;
      if (errorCode === "cancelled") item.inputFactory = null;
    }
  }

  #cancelItem(item: MutableBatchItem): void {
    item.generation += 1;
    item.abortController?.abort();
    item.runner?.cancel();
    this.#releaseItem(item, true);
    item.status = "cancelled";
    item.errorCode = "cancelled";
  }

  #releaseItem(item: MutableBatchItem, releaseFactory: boolean): void {
    item.generation += 1;
    item.abortController?.abort();
    item.abortController = null;
    item.runner?.cancel();
    item.runner?.dispose();
    item.runner = null;
    item.vault?.dispose();
    item.vault = null;
    item.resultId = null;
    item.bytes = 0;
    if (releaseFactory) item.inputFactory = null;
  }

  #reservedBytes(excluded?: MutableBatchItem): number {
    let total = 0;
    for (const item of this.#items) {
      if (item === excluded || item.status === "cancelled") continue;
      total += item.status === "succeeded" ? item.bytes : item.admittedBytes;
    }
    return total;
  }

  #createVault(itemId: string, maxBytes: number): PayloadVault {
    const vault = this.#vaultFactory({ itemId, maxBytes });
    if (!(vault instanceof PayloadVault)) {
      throw new WorkflowBatchError("invalid-item");
    }
    return vault;
  }

  #createItemId(): string {
    const itemId = this.#itemIdFactory();
    if (
      typeof itemId !== "string" ||
      !ITEM_ID_PATTERN.test(itemId) ||
      this.#items.some((item) => item.itemId === itemId)
    ) {
      throw new WorkflowBatchError("invalid-item");
    }
    return itemId;
  }

  #getItem(itemId: string): MutableBatchItem {
    const item = this.#items.find((candidate) => candidate.itemId === itemId);
    if (item === undefined) throw new WorkflowBatchError("unknown-item");
    return item;
  }

  #isCurrent(
    item: MutableBatchItem,
    itemGeneration: number,
    batchGeneration: number,
  ): boolean {
    return (
      !this.#disposed &&
      batchGeneration === this.#generation &&
      itemGeneration === item.generation &&
      item.status === "running"
    );
  }

  #readNow(): number {
    return assertTimestamp(this.#now());
  }

  #assertActive(): void {
    if (this.#disposed) throw new WorkflowBatchError("disposed");
  }
}

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  OperationDefinition,
  OperationExecute,
  OperationManifest,
} from "../../src/operations/contract";
import {
  getActiveOperationMemoryBytes,
  getActiveOperationTaskCount,
  getActiveOperationWorkerCount,
  OperationExecutor,
  type OperationWorkerErrorEvent,
  type OperationWorkerMessageEvent,
} from "../../src/operations/executor";
import {
  OPERATION_WORKER_PROTOCOL_VERSION,
  type OperationWorkerExecuteMessage,
} from "../../src/operations/worker-protocol";
import {
  normalizeOperationOptions,
  resolveOperationSignature,
} from "../../src/operations/validation";
import {
  WorkflowBatchError,
  WorkflowBatchQueue,
  type WorkflowBatchQueueOptions,
} from "../../src/workflows/batch";
import {
  WORKFLOW_RECIPE_FORMAT,
  WORKFLOW_RECIPE_VERSION,
} from "../../src/workflows/contract";
import {
  compileWorkflowCandidate,
  compileWorkflowRecipe,
} from "../../src/workflows/planner";
import { WorkflowRunner } from "../../src/workflows/runner";

const queues: WorkflowBatchQueue[] = [];
let taskSequence = 0;

afterEach(() => {
  for (const queue of queues.splice(0)) queue.dispose();
  expect(getActiveOperationMemoryBytes()).toBe(0);
  expect(getActiveOperationTaskCount()).toBe(0);
  expect(getActiveOperationWorkerCount()).toBe(0);
  vi.restoreAllMocks();
});

const manifest: OperationManifest = {
  version: 1,
  id: "fixture.batch",
  toolSlug: "json-formatter",
  inputKinds: ["text"],
  outputKinds: ["text"],
  maxInputBytes: 1024,
  maxOutputBytes: 1024,
  workingMemoryBytes: 1024,
  options: { additionalProperties: "forbidden", properties: {} },
  signatures: [
    {
      when: {},
      input: [{ kind: "text", contentType: "text/plain" }],
      output: { kind: "text", contentType: "text/plain" },
      determinism: "deterministic",
    },
  ],
  determinism: "deterministic",
  execution: {
    strategy: "main",
    workerThresholdBytes: null,
    timeoutMs: 5000,
  },
  capabilities: {
    network: "forbidden",
    persistence: "forbidden",
    environment: [],
  },
};

const plan = compileWorkflowRecipe(
  {
    format: WORKFLOW_RECIPE_FORMAT,
    version: WORKFLOW_RECIPE_VERSION,
    steps: [{ operationId: manifest.id, options: {} }],
  },
  {
    getManifest: (operationId) =>
      operationId === manifest.id ? manifest : undefined,
    normalizeOptions: normalizeOperationOptions,
    resolveSignature: resolveOperationSignature,
  },
);

function createQueue(
  execute: OperationExecute,
  overrides: WorkflowBatchQueueOptions = {},
): WorkflowBatchQueue {
  let itemSequence = 0;
  const definition: OperationDefinition = { manifest, execute };
  const queue = new WorkflowBatchQueue(plan, {
    itemIdFactory: () => `batch-item-${++itemSequence}`,
    runnerFactory(context) {
      const executor = new OperationExecutor({
        maxActiveWorkers: 0,
        maxActiveMemoryBytes: 4 * 1024 * 1024,
        taskIdFactory: () => `batch-task-${++taskSequence}`,
        getManifest: (operationId) =>
          operationId === manifest.id ? manifest : undefined,
        loadDefinition: async () => definition,
      });
      return new WorkflowRunner({
        executor,
        vault: context.vault,
        disposeExecutor: true,
        maxResidentBytes: context.maxResidentBytes,
        runIdFactory: () => `batch-run-${taskSequence}`,
      });
    },
    ...overrides,
  });
  queues.push(queue);
  return queue;
}

function textInput(text: string) {
  return {
    payload: { kind: "text" as const, text },
    semanticType: "text/plain",
  };
}

describe("WorkflowBatchQueue", () => {
  it("decodes inputs lazily, executes serially and exposes payload-free snapshots", async () => {
    const factories: string[] = [];
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const started = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const revoked: string[] = [];
    let urlSequence = 0;
    const queue = createQueue(
      async (input) => {
        if (input.kind !== "text") throw new Error("unexpected input");
        if (input.text === "first-private-body") {
          firstStarted();
          await firstGate;
        }
        return { kind: "text", text: `${input.text}-done` };
      },
      {
        createObjectUrl: () => `blob:batch-result-${++urlSequence}`,
        revokeObjectUrl: (url) => revoked.push(url),
      },
    );
    const first = queue.enqueue({
      bytes: 10,
      inputFactory() {
        factories.push("first");
        return textInput("first-private-body");
      },
    });
    const second = queue.enqueue({
      bytes: 11,
      inputFactory() {
        factories.push("second");
        return textInput("second-private-body");
      },
    });

    const running = queue.start();
    expect(queue.start()).toBe(running);
    await started;
    expect(factories).toEqual(["first"]);
    expect(() =>
      queue.enqueue({ bytes: 1, inputFactory: () => textInput("late") }),
    ).toThrow(expect.objectContaining({ code: "run-conflict" }));
    releaseFirst();

    const snapshot = await running;
    expect(factories).toEqual(["first", "second"]);
    expect(snapshot.status).toBe("completed");
    expect(snapshot.items.map((item) => item.status)).toEqual([
      "succeeded",
      "succeeded",
    ]);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.items)).toBe(true);
    expect(Object.isFrozen(snapshot.items[0])).toBe(true);
    expect(JSON.stringify(snapshot)).not.toMatch(
      /private-body|original-name|sha256/iu,
    );
    expect(queue.materializeResult(first.itemId)).toEqual({
      kind: "text",
      text: "first-private-body-done",
    });
    expect(
      new TextDecoder().decode(queue.resultBytes(second.itemId).data),
    ).toBe("second-private-body-done");
    expect(queue.resultBytes(second.itemId).contentType).toBe("text/plain");

    const url = queue.createResultObjectUrl(first.itemId);
    expect(url).toBe("blob:batch-result-1");
    queue.clear();
    expect(revoked).toEqual([url]);
    expect(queue.snapshot()).toEqual({
      status: "idle",
      disposed: false,
      items: [],
    });
  });

  it("isolates one failure, continues later items and retries only that item", async () => {
    const executionOrder: string[] = [];
    let retryInputCalls = 0;
    const queue = createQueue((input) => {
      if (input.kind !== "text") throw new Error("unexpected input");
      executionOrder.push(input.text);
      if (input.text === "fail-once") throw new Error("private failure");
      return { kind: "text", text: input.text.toUpperCase() };
    });
    queue.enqueue({ bytes: 3, inputFactory: () => textInput("one") });
    const retryable = queue.enqueue({
      bytes: 9,
      inputFactory() {
        retryInputCalls += 1;
        return textInput(retryInputCalls === 1 ? "fail-once" : "recovered");
      },
    });
    const third = queue.enqueue({
      bytes: 5,
      inputFactory: () => textInput("three"),
    });

    const firstRun = await queue.start();
    expect(firstRun.items.map((item) => item.status)).toEqual([
      "succeeded",
      "failed",
      "succeeded",
    ]);
    expect(firstRun.items[1]).toMatchObject({
      itemId: retryable.itemId,
      errorCode: "operation-failed",
    });
    expect(queue.materializeResult(third.itemId)).toEqual({
      kind: "text",
      text: "THREE",
    });

    const retried = await queue.retry(retryable.itemId);
    expect(retried).toMatchObject({ status: "succeeded" });
    expect(queue.materializeResult(retryable.itemId)).toEqual({
      kind: "text",
      text: "RECOVERED",
    });
    expect(executionOrder).toEqual(["one", "fail-once", "three", "recovered"]);
    await expect(queue.retry(retryable.itemId)).rejects.toMatchObject({
      code: "not-retryable",
    });
  });

  it("aborts a lazy factory and releases all item state on cancellation", async () => {
    let factoryStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      factoryStarted = resolve;
    });
    const queue = createQueue((input) => ({
      kind: "text",
      text: input.kind === "text" ? input.text : "unexpected",
    }));
    queue.enqueue({
      bytes: 100,
      inputFactory(signal) {
        factoryStarted();
        return new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        });
      },
    });
    const pending = queue.enqueue({
      bytes: 100,
      inputFactory: () => textInput("must-never-decode"),
    });
    const run = queue.start();
    await started;

    expect(queue.cancel()).toBe(true);
    expect(queue.cancel()).toBe(false);
    const result = await run;
    expect(result.status).toBe("cancelled");
    expect(result.items).toEqual([
      expect.objectContaining({ status: "cancelled", bytes: 0 }),
      expect.objectContaining({
        itemId: pending.itemId,
        status: "cancelled",
        bytes: 0,
      }),
    ]);
    expect(queue.receiptSource().items).toEqual([
      { status: "cancelled", errorCode: "cancelled" },
      { status: "cancelled", errorCode: "cancelled" },
    ]);
    expect(() => queue.materializeResult(pending.itemId)).toThrow(
      expect.objectContaining({ code: "result-unavailable" }),
    );
  });

  it("enforces bounded admission, opaque IDs and item-level cancellation", async () => {
    const queue = createQueue(
      (input) => ({
        kind: "text",
        text: input.kind === "text" ? input.text : "unexpected",
      }),
      { maxItems: 2, maxItemBytes: 10, maxTotalBytes: 15 },
    );
    expect(() =>
      queue.enqueue({ bytes: 11, inputFactory: () => textInput("large") }),
    ).toThrow(expect.objectContaining({ code: "item-size-limit" }));
    expect(() =>
      queue.enqueue({ bytes: -1, inputFactory: () => textInput("bad") }),
    ).toThrow(expect.objectContaining({ code: "invalid-item" }));

    const first = queue.enqueue({
      bytes: 8,
      inputFactory: () => textInput("a"),
    });
    expect(() =>
      queue.enqueue({ bytes: 8, inputFactory: () => textInput("second") }),
    ).toThrow(expect.objectContaining({ code: "total-size-limit" }));
    const second = queue.enqueue({
      bytes: 7,
      inputFactory: () => textInput("second"),
    });
    expect(() =>
      queue.enqueue({ bytes: 0, inputFactory: () => textInput("third") }),
    ).toThrow(expect.objectContaining({ code: "item-limit" }));
    expect(queue.cancel(second.itemId)).toBe(true);
    expect(queue.cancel(second.itemId)).toBe(false);
    expect(() => queue.cancel("missing-item")).toThrow(
      expect.objectContaining({ code: "unknown-item" }),
    );
    expect(() => queue.materializeResult(first.itemId)).toThrow(
      expect.objectContaining({ code: "result-unavailable" }),
    );

    const finished = await queue.start();
    expect(finished.items).toEqual([
      expect.objectContaining({ status: "succeeded" }),
      expect.objectContaining({ status: "cancelled", bytes: 0 }),
    ]);
    expect(queue.cancel(first.itemId)).toBe(false);
    expect(await queue.start()).toEqual(queue.snapshot());

    queue.dispose();
    queue.dispose();
    expect(queue.snapshot().disposed).toBe(true);
    expect(() =>
      queue.enqueue({ bytes: 1, inputFactory: () => textInput("after") }),
    ).toThrow(expect.objectContaining({ code: "disposed" }));
    expect(queue.cancel()).toBe(false);
  });

  it("rejects decoded inputs that exceed item or remaining total budgets", async () => {
    const itemLimited = createQueue(() => ({ kind: "text", text: "unused" }), {
      maxItemBytes: 8,
      maxTotalBytes: 32,
    });
    itemLimited.enqueue({
      bytes: 1,
      inputFactory: () => textInput("this decoded value is too large"),
    });
    expect((await itemLimited.start()).items[0]).toMatchObject({
      status: "failed",
      errorCode: "item-size-limit",
    });

    const totalLimited = createQueue(() => ({ kind: "text", text: "unused" }), {
      maxItemBytes: 32,
      maxTotalBytes: 16,
    });
    totalLimited.enqueue({ bytes: 8, inputFactory: () => textInput("1234") });
    totalLimited.enqueue({
      bytes: 8,
      inputFactory: () => textInput("decoded text exceeds remaining space"),
    });
    const totalResult = await totalLimited.start();
    expect(totalResult.items[1]).toMatchObject({
      status: "failed",
      errorCode: "total-size-limit",
    });
  });

  it("validates option limits, IDs, clocks and factory ownership", async () => {
    expect(() =>
      createQueue(() => ({ kind: "text", text: "x" }), { maxItems: 65 }),
    ).toThrow(RangeError);
    expect(() =>
      createQueue(() => ({ kind: "text", text: "x" }), {
        maxItemBytes: 0,
      }),
    ).toThrow(RangeError);

    const invalidId = createQueue(() => ({ kind: "text", text: "x" }), {
      itemIdFactory: () => "bad",
    });
    expect(() =>
      invalidId.enqueue({ bytes: 1, inputFactory: () => textInput("x") }),
    ).toThrow(expect.objectContaining({ code: "invalid-item" }));

    const invalidClock = createQueue(() => ({ kind: "text", text: "x" }), {
      now: () => Number.NaN,
    });
    invalidClock.enqueue({ bytes: 1, inputFactory: () => textInput("x") });
    expect(() => invalidClock.start()).toThrow(TypeError);

    const invalidRunner = createQueue(() => ({ kind: "text", text: "x" }), {
      runnerFactory() {
        return new WorkflowRunner();
      },
    });
    invalidRunner.enqueue({ bytes: 1, inputFactory: () => textInput("x") });
    expect((await invalidRunner.start()).items[0]).toMatchObject({
      status: "failed",
      errorCode: "execution-failed",
    });
  });

  it("does not invoke accessors returned by an input factory", async () => {
    let getterCalls = 0;
    const queue = createQueue(() => ({ kind: "text", text: "unused" }));
    queue.enqueue({
      bytes: 1,
      inputFactory() {
        const result: Record<string, unknown> = {
          semanticType: "text/plain",
        };
        Object.defineProperty(result, "payload", {
          enumerable: true,
          get() {
            getterCalls += 1;
            return { kind: "text", text: "secret" };
          },
        });
        return result as never;
      },
    });
    expect((await queue.start()).items[0]).toMatchObject({
      status: "failed",
      errorCode: "input-failed",
    });
    expect(getterCalls).toBe(0);
  });

  it("rejects non-plain and over-specified lazy input envelopes", async () => {
    const queue = createQueue(() => ({ kind: "text", text: "unused" }));
    const candidates: unknown[] = [
      null,
      [],
      new Date(),
      { payload: { kind: "text", text: "x" } },
      {
        payload: { kind: "text", text: "x" },
        semanticType: "text/plain",
        extra: "private",
      },
      {
        payload: { kind: "text", text: "x" },
        semanticType: "text/plain",
        [Symbol("private")]: true,
      },
    ];
    for (const candidate of candidates) {
      queue.enqueue({ bytes: 1, inputFactory: () => candidate as never });
    }

    const snapshot = await queue.start();
    expect(snapshot.items).toHaveLength(candidates.length);
    expect(
      snapshot.items.every(
        (item) => item.status === "failed" && item.errorCode === "input-failed",
      ),
    ).toBe(true);
  });

  it("uses production defaults through the one-task Worker boundary", async () => {
    class Base64WorkerFixture {
      onmessage: ((event: OperationWorkerMessageEvent) => void) | null = null;
      onerror: ((event: OperationWorkerErrorEvent) => void) | null = null;
      onmessageerror: ((event: OperationWorkerMessageEvent) => void) | null =
        null;

      postMessage(message: unknown): void {
        const candidate = structuredClone(
          message,
        ) as OperationWorkerExecuteMessage;
        queueMicrotask(() => {
          const input = candidate.request.input;
          if (input.kind !== "text") throw new Error("unexpected input");
          this.onmessage?.({
            data: {
              version: OPERATION_WORKER_PROTOCOL_VERSION,
              type: "success",
              taskId: candidate.taskId,
              output: {
                kind: "text",
                text: Buffer.from(input.text, "utf8").toString("base64"),
              },
            },
          });
        });
      }

      terminate(): void {}
    }
    vi.stubGlobal("Worker", Base64WorkerFixture);
    const realPlan = compileWorkflowCandidate({
      format: WORKFLOW_RECIPE_FORMAT,
      version: WORKFLOW_RECIPE_VERSION,
      steps: [
        {
          operationId: "base64.codec",
          options: {
            mode: "encode",
            variant: "standard",
            decodedContentType: "text/plain",
          },
        },
      ],
    });
    const queue = new WorkflowBatchQueue(realPlan);
    queues.push(queue);
    const item = queue.enqueue({
      bytes: 5,
      inputFactory: () => textInput("hello"),
    });

    await queue.start();
    expect(queue.snapshot().items[0]).toMatchObject({ status: "succeeded" });
    expect(queue.snapshot().items[0]).not.toHaveProperty("errorCode");
    expect(queue.materializeResult(item.itemId)).toEqual({
      kind: "text",
      text: "aGVsbG8=",
    });
    const url = queue.createResultObjectUrl(item.itemId);
    expect(url.startsWith("blob:")).toBe(true);
    queue.clear();
    vi.unstubAllGlobals();
  });

  it("rejects invalid host factories and non-blob result URLs", async () => {
    const invalidVault = createQueue(() => ({ kind: "text", text: "x" }), {
      vaultFactory: () => ({}) as never,
    });
    invalidVault.enqueue({ bytes: 1, inputFactory: () => textInput("x") });
    expect((await invalidVault.start()).items[0]).toMatchObject({
      status: "failed",
      errorCode: "execution-failed",
    });

    const invalidUrl = createQueue(() => ({ kind: "text", text: "ok" }), {
      createObjectUrl: () => "https://example.test/not-a-blob",
    });
    const item = invalidUrl.enqueue({
      bytes: 1,
      inputFactory: () => textInput("x"),
    });
    await invalidUrl.start();
    expect(() => invalidUrl.createResultObjectUrl(item.itemId)).toThrow(
      expect.objectContaining({ code: "result-unavailable" }),
    );
  });
});

describe("WorkflowBatchError", () => {
  it("uses stable public messages", () => {
    const error = new WorkflowBatchError("unknown-item");
    expect(error).toMatchObject({
      name: "WorkflowBatchError",
      code: "unknown-item",
      message: "The workflow batch item does not exist.",
    });
  });
});

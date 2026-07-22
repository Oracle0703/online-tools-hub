import { readFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  OperationExecutionStrategy,
  OperationManifest,
  OperationOutput,
  OperationRequest,
} from "../../src/operations/contract";
import { OperationError } from "../../src/operations/errors";
import type {
  OperationClock,
  OperationPageLifecycleTarget,
  OperationScheduler,
  OperationWorkerErrorEvent,
  OperationWorkerLike,
  OperationWorkerMessageEvent,
} from "../../src/operations/executor";
import {
  OPERATION_WORKER_PROTOCOL_VERSION,
  type OperationWorkerExecuteMessage,
  type OperationWorkerResponseMessage,
} from "../../src/operations/worker-protocol";
import {
  WorkerOperationExecutor,
  type WorkerOperationExecutorOptions,
} from "../../src/workflows/worker-executor";

const executors: WorkerOperationExecutor[] = [];

afterEach(() => {
  for (const executor of executors) executor.dispose();
  for (const executor of executors) {
    expect(executor.snapshot()).toMatchObject({
      activeTaskCount: 0,
      activeWorkerCount: 0,
      activeMemoryBytes: 0,
      globalActiveTaskCount: 0,
      globalActiveWorkerCount: 0,
    });
  }
  executors.length = 0;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function manifestFor(
  strategy: OperationExecutionStrategy = "main",
  overrides: Partial<OperationManifest> = {},
): OperationManifest {
  return {
    version: 1,
    id: "fixture.echo",
    toolSlug: "json-formatter",
    inputKinds: ["text", "binary"],
    outputKinds: ["text", "binary"],
    maxInputBytes: 1024,
    maxOutputBytes: 1024,
    workingMemoryBytes: 1024,
    options: {
      additionalProperties: "forbidden",
      properties: {
        suffix: {
          type: "string",
          minimumLength: 1,
          maximumLength: 8,
          nullable: false,
        },
      },
    },
    signatures: [
      {
        when: {},
        input: [
          { kind: "text", contentType: "text/plain" },
          { kind: "binary", contentType: "application/octet-stream" },
        ],
        output: { kind: "text", contentType: "text/plain" },
        determinism: "deterministic",
      },
    ],
    determinism: "deterministic",
    execution: {
      strategy,
      workerThresholdBytes:
        strategy === "main" ? null : strategy === "worker" ? 0 : 512,
      timeoutMs: 5000,
    },
    capabilities: {
      network: "forbidden",
      persistence: "forbidden",
      environment: [],
    },
    ...overrides,
  };
}

class FakeWorker implements OperationWorkerLike {
  onmessage: ((event: OperationWorkerMessageEvent) => void) | null = null;
  onerror: ((event: OperationWorkerErrorEvent) => void) | null = null;
  onmessageerror: ((event: OperationWorkerMessageEvent) => void) | null = null;
  postedMessage: OperationWorkerExecuteMessage | undefined;
  postedTransfer: Transferable[] = [];
  terminateCalls = 0;
  throwOnPost: unknown;
  throwOnTerminate: unknown;

  postMessage(message: unknown, transfer: Transferable[] = []): void {
    if (this.throwOnPost !== undefined) throw this.throwOnPost;
    this.postedTransfer = [...transfer];
    this.postedMessage = structuredClone(message, {
      transfer,
    }) as OperationWorkerExecuteMessage;
  }

  terminate(): void {
    this.terminateCalls += 1;
    if (this.throwOnTerminate !== undefined) throw this.throwOnTerminate;
  }

  emit(data: unknown): void {
    this.onmessage?.({ data });
  }

  respond(output: OperationOutput): void {
    this.emit({
      version: OPERATION_WORKER_PROTOCOL_VERSION,
      type: "success",
      taskId: this.postedMessage?.taskId ?? "missing",
      output,
    } satisfies OperationWorkerResponseMessage);
  }

  fail(error: OperationError): void {
    this.emit({
      version: OPERATION_WORKER_PROTOCOL_VERSION,
      type: "failure",
      taskId: this.postedMessage?.taskId ?? "missing",
      error: error.toJSON(),
    } satisfies OperationWorkerResponseMessage);
  }
}

class FakeScheduler implements OperationScheduler {
  readonly callbacks = new Map<number, () => void>();
  readonly delays: number[] = [];
  nextHandle = 0;
  throwOnSet: unknown;
  throwOnClear: unknown;

  setTimeout(callback: () => void, timeoutMs: number): unknown {
    if (this.throwOnSet !== undefined) throw this.throwOnSet;
    this.nextHandle += 1;
    this.callbacks.set(this.nextHandle, callback);
    this.delays.push(timeoutMs);
    return this.nextHandle;
  }

  clearTimeout(handle: unknown): void {
    this.callbacks.delete(handle as number);
    if (this.throwOnClear !== undefined) throw this.throwOnClear;
  }

  fire(): void {
    const callbacks = [...this.callbacks.values()];
    this.callbacks.clear();
    for (const callback of callbacks) callback();
  }
}

class FakePageLifecycleTarget implements OperationPageLifecycleTarget {
  listener: (() => void) | undefined;
  addCalls = 0;
  removeCalls = 0;

  addEventListener(type: "pagehide", listener: () => void): void {
    if (type === "pagehide") {
      this.addCalls += 1;
      this.listener = listener;
    }
  }

  removeEventListener(type: "pagehide", listener: () => void): void {
    if (type === "pagehide" && this.listener === listener) {
      this.removeCalls += 1;
      this.listener = undefined;
    }
  }

  pageHide(): void {
    this.listener?.();
  }
}

function textRequest(text = "hello"): OperationRequest {
  return {
    operationId: "fixture.echo",
    input: { kind: "text", text },
    options: { suffix: "!" },
  };
}

function createExecutor(
  manifest: OperationManifest,
  options: WorkerOperationExecutorOptions = {},
): { executor: WorkerOperationExecutor; workers: FakeWorker[] } {
  const workers: FakeWorker[] = [];
  let taskSequence = 0;
  const executor = new WorkerOperationExecutor({
    getManifest: (operationId) =>
      operationId === manifest.id ? manifest : undefined,
    taskIdFactory: () => `workflow-fixture-${++taskSequence}`,
    workerFactory: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
    ...options,
  });
  executors.push(executor);
  return { executor, workers };
}

describe("WorkerOperationExecutor admission and isolation", () => {
  it.each(["main", "adaptive", "worker"] as const)(
    "forces a %s manifest through a Worker and transfers only its private snapshot",
    async (strategy) => {
      const manifest = manifestFor(strategy);
      const workers: FakeWorker[] = [];
      let createdFor:
        Readonly<{ taskId: string; operationId: string }> | undefined;
      const { executor } = createExecutor(manifest, {
        workerFactory(details) {
          createdFor = details;
          const worker = new FakeWorker();
          workers.push(worker);
          return worker;
        },
      });
      const source = Uint8Array.from([1, 2, 3, 4]).buffer;
      const request: OperationRequest = {
        operationId: manifest.id,
        input: { kind: "binary", data: source },
        options: { suffix: "!" },
      };

      const task = executor.execute(request);

      expect(task.location).toBe("worker");
      expect(createdFor).toEqual({
        taskId: task.taskId,
        operationId: manifest.id,
      });
      expect(source.byteLength).toBe(4);
      expect(workers[0]?.postedTransfer).toHaveLength(1);
      expect(workers[0]?.postedMessage?.request.input).toMatchObject({
        kind: "binary",
      });
      if (workers[0]?.postedMessage?.request.input.kind === "binary") {
        expect([
          ...new Uint8Array(workers[0].postedMessage.request.input.data),
        ]).toEqual([1, 2, 3, 4]);
      }
      expect(executor.snapshot()).toMatchObject({
        activeTaskCount: 1,
        activeWorkerCount: 1,
        activeMemoryBytes: manifest.workingMemoryBytes,
      });

      workers[0]?.respond({ kind: "text", text: "done" });
      await expect(task.promise).resolves.toEqual({
        kind: "text",
        text: "done",
      });
      expect(workers[0]?.terminateCalls).toBe(1);
      expect(executor.snapshot()).toMatchObject({
        activeTaskCount: 0,
        activeWorkerCount: 0,
        activeMemoryBytes: 0,
      });
    },
  );

  it("uses an immutable admission clone after the caller mutates its request", async () => {
    const { executor, workers } = createExecutor(manifestFor());
    const request = textRequest("before") as {
      operationId: string;
      input: { kind: "text"; text: string };
      options: { suffix: string };
    };

    const task = executor.execute(request);
    request.input.text = "after";
    request.options.suffix = "?";

    expect(workers[0]?.postedMessage?.request).toEqual(textRequest("before"));
    workers[0]?.respond({ kind: "text", text: "before!" });
    await expect(task.promise).resolves.toMatchObject({ text: "before!" });
  });

  it("validates source requests before Worker creation", () => {
    const { executor, workers } = createExecutor(manifestFor());
    const aborted = new AbortController();
    aborted.abort();

    expect(() =>
      executor.execute({
        operationId: "missing.operation",
        input: { kind: "text", text: "x" },
      }),
    ).toThrow(expect.objectContaining({ code: "unknown-operation" }));
    expect(() =>
      executor.execute(
        {
          operationId: "fixture.echo",
          input: { kind: "empty" },
        },
        { signal: aborted.signal },
      ),
    ).toThrow(expect.objectContaining({ code: "type-mismatch" }));
    expect(() =>
      executor.execute(textRequest(), { signal: aborted.signal }),
    ).toThrow(expect.objectContaining({ code: "cancelled" }));
    expect(() => executor.execute(textRequest(), { timeoutMs: 0 })).toThrow(
      RangeError,
    );
    expect(workers).toHaveLength(0);
  });

  it("revalidates a structured-clone snapshot and releases admission on clone failure", () => {
    const { executor, workers } = createExecutor(manifestFor());
    vi.spyOn(globalThis, "structuredClone").mockImplementationOnce(() => {
      throw new DOMException("fixture", "DataCloneError");
    });

    expect(() => executor.execute(textRequest("private"))).toThrow(
      expect.objectContaining({ code: "type-mismatch" }),
    );
    expect(workers).toHaveLength(0);
    expect(executor.snapshot()).toMatchObject({
      activeTaskCount: 0,
      activeMemoryBytes: 0,
      globalActiveTaskCount: 0,
    });
  });

  it("rejects accessor-backed request IDs without invoking the accessor", () => {
    const { executor } = createExecutor(manifestFor());
    let getterCalls = 0;
    const request = { input: { kind: "text", text: "x" } };
    Object.defineProperty(request, "operationId", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "fixture.echo";
      },
    });

    expect(() => executor.execute(request as OperationRequest)).toThrow(
      expect.objectContaining({ code: "unknown-operation" }),
    );
    expect(getterCalls).toBe(0);
  });
});

describe("WorkerOperationExecutor response boundary", () => {
  it("rejects malformed, mismatched and invalid-output Worker messages", async () => {
    const fixture = createExecutor(manifestFor());
    const malformed = fixture.executor.execute(textRequest());
    fixture.workers[0]?.emit({ type: "success" });
    await expect(malformed.promise).rejects.toMatchObject({
      code: "worker-crashed",
    });

    const mismatched = fixture.executor.execute(textRequest());
    fixture.workers[1]?.emit({
      version: OPERATION_WORKER_PROTOCOL_VERSION,
      type: "success",
      taskId: "different-task",
      output: { kind: "text", text: "x" },
    });
    await expect(mismatched.promise).rejects.toMatchObject({
      code: "worker-crashed",
    });

    const invalidOutput = fixture.executor.execute(textRequest());
    fixture.workers[2]?.respond({ kind: "text", text: "x".repeat(1025) });
    await expect(invalidOutput.promise).rejects.toMatchObject({
      code: "output-too-large",
    });
    expect(fixture.workers.map((worker) => worker.terminateCalls)).toEqual([
      1, 1, 1,
    ]);
  });

  it("canonicalizes every Worker failure without exposing its message or details", async () => {
    const codes = [
      "unknown-operation",
      "type-mismatch",
      "input-too-large",
      "output-too-large",
      "memory-budget",
      "invalid-options",
      "timeout",
      "cancelled",
      "worker-crashed",
      "unsupported-environment",
      "execution-failed",
    ] as const;
    const fixture = createExecutor(manifestFor());

    for (const code of codes) {
      const task = fixture.executor.execute(textRequest());
      fixture.workers.at(-1)?.fail(
        new OperationError(code, "private worker detail", {
          operationId: "different.operation",
          details: { secret: "must-not-cross" },
        }),
      );
      const failure = await task.promise.catch((error: unknown) => error);
      expect(failure).toMatchObject({
        name: "OperationError",
        code,
        operationId: "fixture.echo",
      });
      expect(JSON.stringify(failure)).not.toContain("private worker detail");
      expect(JSON.stringify(failure)).not.toContain("must-not-cross");
      expect(JSON.stringify(failure)).not.toContain("different.operation");
    }
  });

  it("maps Worker crashes, message errors, startup errors and post errors", async () => {
    const fixture = createExecutor(manifestFor());

    const crashed = fixture.executor.execute(textRequest());
    const preventDefault = vi.fn();
    fixture.workers[0]?.onerror?.({
      message: "private crash",
      preventDefault,
    });
    await expect(crashed.promise).rejects.toMatchObject({
      code: "worker-crashed",
    });
    expect(preventDefault).toHaveBeenCalledOnce();

    const messageError = fixture.executor.execute(textRequest());
    fixture.workers[1]?.onmessageerror?.({ data: "private body" });
    await expect(messageError.promise).rejects.toMatchObject({
      code: "worker-crashed",
    });

    const startup = createExecutor(manifestFor(), {
      workerFactory() {
        throw new Error("private startup failure");
      },
    });
    const startupTask = startup.executor.execute(textRequest());
    await expect(startupTask.promise).rejects.toMatchObject({
      code: "worker-crashed",
      message: "Operation Worker could not be started.",
    });

    const unsupported = createExecutor(manifestFor(), {
      workerFactory() {
        throw new OperationError(
          "unsupported-environment",
          "No Worker fixture.",
        );
      },
    });
    await expect(
      unsupported.executor.execute(textRequest()).promise,
    ).rejects.toMatchObject({ code: "unsupported-environment" });

    const postFailure = createExecutor(manifestFor());
    const worker = new FakeWorker();
    worker.throwOnPost = new Error("private post failure");
    const posting = createExecutor(manifestFor(), {
      workerFactory: () => worker,
    });
    const postTask = posting.executor.execute(textRequest());
    await expect(postTask.promise).rejects.toMatchObject({
      code: "worker-crashed",
    });
    expect(postFailure.executor.snapshot().activeTaskCount).toBe(0);
  });

  it("ignores late Worker responses after a task settles", async () => {
    const { executor, workers } = createExecutor(manifestFor());
    const task = executor.execute(textRequest());
    const worker = workers[0]!;
    const lateHandler = worker.onmessage;

    worker.respond({ kind: "text", text: "first" });
    await expect(task.promise).resolves.toMatchObject({ text: "first" });
    lateHandler?.({
      data: {
        version: OPERATION_WORKER_PROTOCOL_VERSION,
        type: "success",
        taskId: task.taskId,
        output: { kind: "text", text: "late" },
      },
    });
    expect(executor.snapshot().activeTaskCount).toBe(0);
    expect(worker.terminateCalls).toBe(1);
  });
});

describe("WorkerOperationExecutor budgets and lifecycle", () => {
  it("enforces global memory, task and Worker limits and releases them on cancel", async () => {
    const memory = createExecutor(manifestFor(), {
      maxActiveMemoryBytes: 1024,
      maxActiveTasks: 4,
      maxActiveWorkers: 4,
    });
    const first = memory.executor.execute(textRequest("one"));
    expect(() => memory.executor.execute(textRequest("two"))).toThrow(
      expect.objectContaining({ code: "memory-budget" }),
    );
    const firstFailure = first.promise.catch((error: unknown) => error);
    expect(first.cancel()).toBe(true);
    expect(first.cancel()).toBe(false);
    await expect(firstFailure).resolves.toMatchObject({ code: "cancelled" });

    const tasks = createExecutor(manifestFor(), {
      maxActiveMemoryBytes: 4096,
      maxActiveTasks: 1,
      maxActiveWorkers: 4,
    });
    const task = tasks.executor.execute(textRequest());
    expect(() => tasks.executor.execute(textRequest())).toThrow(
      expect.objectContaining({ code: "memory-budget" }),
    );
    const taskFailure = task.promise.catch((error: unknown) => error);
    tasks.executor.cancelAll();
    await expect(taskFailure).resolves.toMatchObject({ code: "cancelled" });

    const workers = createExecutor(manifestFor(), {
      maxActiveMemoryBytes: 4096,
      maxActiveTasks: 4,
      maxActiveWorkers: 1,
    });
    const workerTask = workers.executor.execute(textRequest());
    expect(() => workers.executor.execute(textRequest())).toThrow(
      expect.objectContaining({ code: "memory-budget" }),
    );
    const workerFailure = workerTask.promise.catch((error: unknown) => error);
    expect(workers.executor.cancelAll()).toBe(1);
    expect(workers.executor.cancelAll()).toBe(0);
    await expect(workerFailure).resolves.toMatchObject({ code: "cancelled" });
  });

  it("enforces limits across Worker executors", async () => {
    const first = createExecutor(manifestFor(), {
      maxActiveMemoryBytes: 2048,
      maxActiveWorkers: 2,
    });
    const second = createExecutor(manifestFor(), {
      maxActiveMemoryBytes: 1024,
      maxActiveWorkers: 2,
    });
    const active = first.executor.execute(textRequest());

    expect(second.executor.snapshot()).toMatchObject({
      activeMemoryBytes: 1024,
      globalActiveTaskCount: 1,
      globalActiveWorkerCount: 1,
    });
    expect(() => second.executor.execute(textRequest())).toThrow(
      expect.objectContaining({ code: "memory-budget" }),
    );
    const failure = active.promise.catch((error: unknown) => error);
    active.cancel();
    await expect(failure).resolves.toMatchObject({ code: "cancelled" });
  });

  it("cancels from AbortSignal, pagehide and dispose and removes listeners", async () => {
    const { executor, workers } = createExecutor(manifestFor());
    const controller = new AbortController();
    const signalled = executor.execute(textRequest(), {
      signal: controller.signal,
    });
    const signalledFailure = signalled.promise.catch((error: unknown) => error);
    controller.abort();
    await expect(signalledFailure).resolves.toMatchObject({
      code: "cancelled",
    });

    const target = new FakePageLifecycleTarget();
    const unbind = executor.bindPageHide(target);
    const hidden = executor.execute(textRequest());
    const hiddenFailure = hidden.promise.catch((error: unknown) => error);
    target.pageHide();
    await expect(hiddenFailure).resolves.toMatchObject({ code: "cancelled" });
    expect(target.addCalls).toBe(1);
    unbind();
    unbind();
    expect(target.removeCalls).toBe(1);

    executor.bindPageHide(target);
    const disposed = executor.execute(textRequest());
    const disposedFailure = disposed.promise.catch((error: unknown) => error);
    executor.dispose();
    executor.dispose();
    await expect(disposedFailure).resolves.toMatchObject({ code: "cancelled" });
    expect(executor.snapshot()).toMatchObject({ disposed: true });
    expect(target.listener).toBeUndefined();
    expect(() => executor.execute(textRequest())).toThrow(
      expect.objectContaining({ code: "cancelled" }),
    );
    expect(() => executor.bindPageHide(target)).toThrow(
      expect.objectContaining({ code: "cancelled" }),
    );
    expect(workers.every((worker) => worker.terminateCalls === 1)).toBe(true);
  });

  it("terminates timed-out Workers and honors only shorter timeout overrides", async () => {
    let now = 100;
    const scheduler = new FakeScheduler();
    const clock: OperationClock = { now: () => now };
    const { executor, workers } = createExecutor(manifestFor(), {
      scheduler,
      clock,
    });

    const task = executor.execute(textRequest(), { timeoutMs: 250 });
    expect(scheduler.delays).toEqual([250]);
    scheduler.fire();
    await expect(task.promise).rejects.toMatchObject({ code: "timeout" });
    expect(workers[0]?.terminateCalls).toBe(1);

    const atDeadline = executor.execute(textRequest());
    now += 5000;
    workers[1]?.respond({ kind: "text", text: "too late" });
    await expect(atDeadline.promise).rejects.toMatchObject({ code: "timeout" });
  });

  it("fails closed around clock and scheduler host errors", async () => {
    const invalidClock = createExecutor(manifestFor(), {
      clock: { now: () => Number.NaN },
    });
    expect(() => invalidClock.executor.execute(textRequest())).toThrow(
      RangeError,
    );

    let calls = 0;
    const lateInvalidClock = createExecutor(manifestFor(), {
      clock: {
        now() {
          calls += 1;
          return calls === 1 ? 0 : Number.POSITIVE_INFINITY;
        },
      },
    });
    await expect(
      lateInvalidClock.executor.execute(textRequest()).promise,
    ).rejects.toMatchObject({ code: "execution-failed" });

    const scheduler = new FakeScheduler();
    scheduler.throwOnSet = new Error("private scheduler error");
    const failedScheduler = createExecutor(manifestFor(), { scheduler });
    await expect(
      failedScheduler.executor.execute(textRequest()).promise,
    ).rejects.toMatchObject({ code: "execution-failed" });
  });

  it("releases state when host cleanup primitives throw", async () => {
    const scheduler = new FakeScheduler();
    scheduler.throwOnClear = new Error("clear failed");
    const worker = new FakeWorker();
    worker.throwOnTerminate = new Error("terminate failed");
    const { executor } = createExecutor(manifestFor(), {
      scheduler,
      workerFactory: () => worker,
    });
    const task = executor.execute(textRequest());

    worker.respond({ kind: "text", text: "done" });
    await expect(task.promise).resolves.toMatchObject({ text: "done" });
    expect(executor.snapshot()).toMatchObject({
      activeTaskCount: 0,
      activeMemoryBytes: 0,
    });
  });

  it("validates constructor bounds and task IDs, including collisions", async () => {
    expect(
      () => new WorkerOperationExecutor({ maxActiveMemoryBytes: 0 }),
    ).toThrow(RangeError);
    expect(() => new WorkerOperationExecutor({ maxActiveTasks: 0 })).toThrow(
      RangeError,
    );
    expect(() => new WorkerOperationExecutor({ maxActiveWorkers: -1 })).toThrow(
      RangeError,
    );

    const invalid = createExecutor(manifestFor(), {
      taskIdFactory: () => "unsafe id",
    });
    expect(() => invalid.executor.execute(textRequest())).toThrow(TypeError);

    const workers: FakeWorker[] = [];
    const duplicate = new WorkerOperationExecutor({
      maxActiveMemoryBytes: 4096,
      maxActiveWorkers: 2,
      getManifest: () => manifestFor(),
      taskIdFactory: () => "duplicate-task",
      workerFactory: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
      },
    });
    executors.push(duplicate);
    const first = duplicate.execute(textRequest());
    const second = duplicate.execute(textRequest());
    expect(second.taskId).not.toBe(first.taskId);
    const firstFailure = first.promise.catch((error: unknown) => error);
    const secondFailure = second.promise.catch((error: unknown) => error);
    duplicate.cancelAll();
    await expect(firstFailure).resolves.toMatchObject({ code: "cancelled" });
    await expect(secondFailure).resolves.toMatchObject({ code: "cancelled" });
  });

  it("uses the browser Worker factory when one is available", async () => {
    const constructed: Array<{ url: URL; options: WorkerOptions }> = [];
    const workers: FakeWorker[] = [];
    class BrowserWorkerFixture extends FakeWorker {
      constructor(url: URL, options: WorkerOptions) {
        super();
        constructed.push({ url, options });
        workers.push(this);
      }
    }
    vi.stubGlobal("Worker", BrowserWorkerFixture);
    const sharedManifest = manifestFor("worker");
    const qrManifest = manifestFor("worker", { id: "qr.transform" });
    let taskSequence = 0;
    const executor = new WorkerOperationExecutor({
      getManifest: (operationId) => {
        if (operationId === sharedManifest.id) return sharedManifest;
        if (operationId === qrManifest.id) return qrManifest;
        return undefined;
      },
      taskIdFactory: () => `browser-worker-task-${++taskSequence}`,
    });
    executors.push(executor);

    const sharedTask = executor.execute(textRequest());
    expect(constructed[0]?.options).toEqual({
      type: "module",
      name: "online-tools-workflow-operation",
    });
    expect(constructed[0]?.url.pathname).toContain("operation.worker.ts");
    expect(constructed[0]?.url.pathname).not.toContain(
      "qr-operation.worker.ts",
    );
    workers[0]?.respond({ kind: "text", text: "ready" });
    await expect(sharedTask.promise).resolves.toMatchObject({ text: "ready" });

    const qrTask = executor.execute({
      operationId: qrManifest.id,
      input: { kind: "text", text: "private QR input" },
    });
    expect(constructed[1]?.options).toEqual({
      type: "module",
      name: "online-tools-workflow-operation-qr",
    });
    expect(constructed[1]?.url.pathname).toContain("qr-operation.worker.ts");
    workers[1]?.respond({ kind: "text", text: "QR ready" });
    await expect(qrTask.promise).resolves.toMatchObject({ text: "QR ready" });
  });

  it("reports unsupported environments through the canonical task promise", async () => {
    vi.stubGlobal("Worker", undefined);
    const executor = new WorkerOperationExecutor({
      getManifest: () => manifestFor(),
      taskIdFactory: () => "missing-worker-task",
    });
    executors.push(executor);

    await expect(executor.execute(textRequest()).promise).rejects.toMatchObject(
      {
        code: "unsupported-environment",
      },
    );
    vi.unstubAllGlobals();
  });
});

describe("WorkflowRunner executor import boundary", () => {
  it("keeps the full runtime registry and adapters out of the default page realm", async () => {
    const runnerSource = await readFile(
      path.resolve("src/workflows/runner.ts"),
      "utf8",
    );
    const workerExecutorSource = await readFile(
      path.resolve("src/workflows/worker-executor.ts"),
      "utf8",
    );

    expect(runnerSource).not.toMatch(
      /import\s*\{[^}]*OperationExecutor[^}]*\}\s*from\s*["']\.\.\/operations\/executor["']/u,
    );
    expect(workerExecutorSource).toContain("import type {");
    expect(workerExecutorSource).not.toContain(
      'from "../operations/runtime-registry"',
    );
    expect(workerExecutorSource).not.toMatch(
      /(?:from|import\s*\()\s*["'][^"']*\/adapters\//u,
    );
  });
});

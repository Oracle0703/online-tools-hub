import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  OperationDefinition,
  OperationExecutionStrategy,
  OperationManifest,
  OperationOutput,
  OperationRequest,
} from "../../src/operations/contract";
import {
  IMAGE_OPERATION_MANIFEST,
  JSON_OPERATION_MANIFEST,
} from "../../src/operations/catalog";
import {
  DEFAULT_ADAPTIVE_WORKER_THRESHOLD_BYTES,
  DEFAULT_MAX_ACTIVE_OPERATION_MEMORY_BYTES,
  getActiveOperationMemoryBytes,
  getActiveOperationTaskCount,
  getActiveOperationWorkerCount,
  OperationExecutor,
  type OperationClock,
  type OperationExecutorOptions,
  type OperationPageLifecycleTarget,
  type OperationScheduler,
  type OperationWorkerErrorEvent,
  type OperationWorkerLike,
  type OperationWorkerMessageEvent,
} from "../../src/operations/executor";
import { OperationError } from "../../src/operations/errors";
import { loadOperationDefinition } from "../../src/operations/runtime-registry";
import {
  assertWorkingMemoryWithinBudget,
  validateOperationOutput,
  validateOperationRequest,
} from "../../src/operations/validation";
import {
  isOperationWorkerResponseMessage,
  MAX_OPERATION_WORKER_ERROR_DETAILS_BYTES,
  MAX_OPERATION_WORKER_ERROR_MESSAGE_LENGTH,
  OPERATION_WORKER_PROTOCOL_VERSION,
  type OperationWorkerExecuteMessage,
  type OperationWorkerResponseMessage,
} from "../../src/operations/worker-protocol";

const MEBIBYTE = 1024 * 1024;
const executors: OperationExecutor[] = [];

afterEach(() => {
  for (const executor of executors.splice(0)) executor.dispose();
  expect(getActiveOperationMemoryBytes()).toBe(0);
  expect(getActiveOperationTaskCount()).toBe(0);
  expect(getActiveOperationWorkerCount()).toBe(0);
  vi.restoreAllMocks();
});

function manifestFor(
  strategy: OperationExecutionStrategy,
  overrides: Partial<OperationManifest> = {},
): OperationManifest {
  return {
    version: 1,
    id: "test.echo",
    toolSlug: "json-formatter",
    inputKinds: ["text", "binary"],
    outputKinds: ["text", "binary"],
    maxInputBytes: MEBIBYTE,
    maxOutputBytes: MEBIBYTE,
    workingMemoryBytes: MEBIBYTE,
    execution: {
      strategy,
      workerThresholdBytes:
        strategy === "main"
          ? null
          : strategy === "worker"
            ? 0
            : DEFAULT_ADAPTIVE_WORKER_THRESHOLD_BYTES,
      timeoutMs: 5_000,
    },
    capabilities: {
      network: "forbidden",
      persistence: "forbidden",
      environment: [],
    },
    ...overrides,
  };
}

function textRequest(text = "hello"): OperationRequest {
  return {
    operationId: "test.echo",
    input: { kind: "text", text },
  };
}

function binaryRequest(bytes: number[]): OperationRequest {
  return {
    operationId: "test.echo",
    input: { kind: "binary", data: Uint8Array.from(bytes).buffer },
  };
}

function echoDefinition(manifest: OperationManifest): OperationDefinition {
  return {
    manifest,
    execute(input) {
      if (input.kind === "text") return { kind: "text", text: input.text };
      if (input.kind === "binary") {
        return { kind: "binary", data: input.data.slice(0) };
      }
      throw new Error("Unexpected fixture input.");
    },
  };
}

function createExecutor(
  manifest: OperationManifest,
  options: Omit<OperationExecutorOptions, "getManifest" | "loadDefinition"> & {
    loadDefinition?: (operationId: string) => Promise<OperationDefinition>;
  } = {},
): OperationExecutor {
  let taskSequence = 0;
  const executor = new OperationExecutor({
    getManifest: (operationId) =>
      operationId === manifest.id ? manifest : undefined,
    loadDefinition:
      options.loadDefinition ?? (async () => echoDefinition(manifest)),
    taskIdFactory: () => {
      taskSequence += 1;
      return `fixture-${taskSequence}`;
    },
    ...options,
  });
  executors.push(executor);
  return executor;
}

class FakeWorker implements OperationWorkerLike {
  onmessage: ((event: OperationWorkerMessageEvent) => void) | null = null;
  onerror: ((event: OperationWorkerErrorEvent) => void) | null = null;
  onmessageerror: ((event: OperationWorkerMessageEvent) => void) | null = null;
  postedMessage: OperationWorkerExecuteMessage | undefined;
  postedTransfer: Transferable[] = [];
  terminateCalls = 0;

  postMessage(message: unknown, transfer: Transferable[] = []): void {
    this.postedTransfer = transfer;
    this.postedMessage = structuredClone(message, {
      transfer,
    }) as OperationWorkerExecuteMessage;
  }

  terminate(): void {
    this.terminateCalls += 1;
  }

  respond(output: OperationOutput): void {
    this.onmessage?.({
      data: {
        version: OPERATION_WORKER_PROTOCOL_VERSION,
        type: "success",
        taskId: this.postedMessage?.taskId ?? "missing",
        output,
      } satisfies OperationWorkerResponseMessage,
    });
  }

  fail(error: OperationError): void {
    this.onmessage?.({
      data: {
        version: OPERATION_WORKER_PROTOCOL_VERSION,
        type: "failure",
        taskId: this.postedMessage?.taskId ?? "missing",
        error: error.toJSON(),
      } satisfies OperationWorkerResponseMessage,
    });
  }

  crash(message = "fixture crash"): void {
    this.onerror?.({ message, preventDefault: vi.fn() });
  }
}

class InProcessProtocolWorker extends FakeWorker {
  constructor(private readonly manifest: OperationManifest) {
    super();
  }

  override postMessage(message: unknown, transfer: Transferable[] = []): void {
    super.postMessage(message, transfer);
    queueMicrotask(() => void this.executePostedMessage());
  }

  private async executePostedMessage(): Promise<void> {
    const request = this.postedMessage?.request;
    const validation = validateOperationRequest(this.manifest, request);
    if (!validation.ok) {
      this.fail(validation.error);
      return;
    }

    try {
      const definition = await loadOperationDefinition(
        validation.value.operationId,
      );
      const signal = new AbortController().signal;
      const output = await definition.execute(
        validation.value.input,
        validation.value.options ?? {},
        {
          location: "worker",
          signal,
          checkCancelled() {
            if (signal.aborted) {
              throw new OperationError("cancelled", "Operation was cancelled.");
            }
          },
          assertWorkingMemory: (bytes) =>
            assertWorkingMemoryWithinBudget(this.manifest, bytes),
        },
      );
      const outputValidation = validateOperationOutput(this.manifest, output);
      if (!outputValidation.ok) {
        this.fail(outputValidation.error);
        return;
      }
      this.respond(outputValidation.value);
    } catch (error) {
      this.fail(
        error instanceof OperationError
          ? error
          : new OperationError(
              "execution-failed",
              "In-process Worker fixture failed.",
              { operationId: this.manifest.id, cause: error },
            ),
      );
    }
  }
}

class ManualScheduler implements OperationScheduler {
  callbacks = new Map<number, () => void>();
  cleared: number[] = [];
  private sequence = 0;

  setTimeout(callback: () => void): number {
    this.sequence += 1;
    this.callbacks.set(this.sequence, callback);
    return this.sequence;
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === "number") {
      this.callbacks.delete(handle);
      this.cleared.push(handle);
    }
  }

  fire(handle = 1): void {
    this.callbacks.get(handle)?.();
  }
}

class ManualClock implements OperationClock {
  value = 0;

  now(): number {
    return this.value;
  }
}

class PageLifecycleTarget implements OperationPageLifecycleTarget {
  listener: (() => void) | undefined;

  addEventListener(_type: "pagehide", listener: () => void): void {
    this.listener = listener;
  }

  removeEventListener(_type: "pagehide", listener: () => void): void {
    if (this.listener === listener) this.listener = undefined;
  }

  hide(): void {
    this.listener?.();
  }
}

describe("OperationExecutor main-thread execution", () => {
  it("executes a validated small task and releases its input reservation", async () => {
    const manifest = manifestFor("adaptive");
    const execute = vi.fn(echoDefinition(manifest).execute);
    const executor = createExecutor(manifest, {
      loadDefinition: async () => ({ manifest, execute }),
    });

    const task = executor.execute(textRequest("small"));

    expect(task.location).toBe("main");
    expect(getActiveOperationMemoryBytes()).toBe(MEBIBYTE);
    await expect(task.promise).resolves.toEqual({
      kind: "text",
      text: "small",
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[2]).toMatchObject({ location: "main" });
    expect(getActiveOperationMemoryBytes()).toBe(0);
    expect(executor.snapshot().activeTaskCount).toBe(0);
  });

  it("normalizes implementation failures without leaking a non-contract error", async () => {
    const manifest = manifestFor("main");
    const executor = createExecutor(manifest, {
      loadDefinition: async () => ({
        manifest,
        execute() {
          throw new RangeError("adapter detail");
        },
      }),
    });

    await expect(executor.execute(textRequest()).promise).rejects.toMatchObject(
      {
        name: "OperationError",
        code: "execution-failed",
        operationId: manifest.id,
      },
    );
  });

  it("executes a data-only snapshot when caller text and options mutate", async () => {
    const manifest = manifestFor("main");
    const input = { kind: "text" as const, text: "before" };
    const options = { suffix: "-one" };
    const request: OperationRequest = {
      operationId: manifest.id,
      input,
      options,
    };
    const executor = createExecutor(manifest, {
      loadDefinition: async () => ({
        manifest,
        execute(snapshotInput, snapshotOptions) {
          if (snapshotInput.kind !== "text") {
            throw new Error("Unexpected fixture input.");
          }
          return {
            kind: "text",
            text: `${snapshotInput.text}${String(snapshotOptions.suffix)}`,
          };
        },
      }),
    });

    const task = executor.execute(request);
    input.text = "after";
    options.suffix = "-two";

    await expect(task.promise).resolves.toEqual({
      kind: "text",
      text: "before-one",
    });
  });

  it("rejects a synchronous algorithm that finishes after its deadline", async () => {
    const manifest = manifestFor("main");
    const clock = new ManualClock();
    const scheduler = new ManualScheduler();
    const executor = createExecutor(manifest, {
      clock,
      scheduler,
      loadDefinition: async () => ({
        manifest,
        execute() {
          // Models a synchronous core that blocks the event loop past the
          // deadline, preventing the scheduled timeout callback from running.
          clock.value = 20;
          return { kind: "text", text: "too late" };
        },
      }),
    });

    const task = executor.execute(textRequest(), { timeoutMs: 20 });

    await expect(task.promise).rejects.toMatchObject({ code: "timeout" });
    expect(scheduler.cleared).toEqual([1]);
    expect(executor.snapshot().activeTaskCount).toBe(0);
  });

  it("aborts an asynchronous main task and ignores its late result", async () => {
    const manifest = manifestFor("main");
    let complete!: (output: OperationOutput) => void;
    let capturedSignal: AbortSignal | undefined;
    const executor = createExecutor(manifest, {
      loadDefinition: async () => ({
        manifest,
        execute(_input, _options, context) {
          capturedSignal = context.signal;
          return new Promise<OperationOutput>((resolve) => {
            complete = resolve;
          });
        },
      }),
    });
    const task = executor.execute(textRequest());
    await vi.waitFor(() => expect(capturedSignal).toBeDefined());

    expect(task.cancel()).toBe(true);
    expect(capturedSignal?.aborted).toBe(true);
    await expect(task.promise).rejects.toMatchObject({ code: "cancelled" });
    complete({ kind: "text", text: "late" });
    await Promise.resolve();
    expect(task.cancel()).toBe(false);
    expect(executor.snapshot().activeTaskCount).toBe(0);
  });
});

describe("OperationExecutor Worker isolation", () => {
  it("keeps the real JSON adapter consistent across main and Worker protocol execution", async () => {
    const mainManifest: OperationManifest = {
      ...JSON_OPERATION_MANIFEST,
      execution: {
        strategy: "main",
        workerThresholdBytes: null,
        timeoutMs: JSON_OPERATION_MANIFEST.execution.timeoutMs,
      },
    };
    const workerManifest: OperationManifest = {
      ...JSON_OPERATION_MANIFEST,
      execution: {
        strategy: "worker",
        workerThresholdBytes: 0,
        timeoutMs: JSON_OPERATION_MANIFEST.execution.timeoutMs,
      },
    };
    const request: OperationRequest = {
      operationId: JSON_OPERATION_MANIFEST.id,
      input: { kind: "text", text: '{"z":1,"items":[true,false]}' },
      options: { mode: "format", indent: 2 },
    };
    const main = createExecutor(mainManifest, {
      loadDefinition: loadOperationDefinition,
    });
    const isolated = createExecutor(workerManifest, {
      workerFactory: () => new InProcessProtocolWorker(workerManifest),
    });

    const [directOutput, workerOutput] = await Promise.all([
      main.execute(request).promise,
      isolated.execute(request).promise,
    ]);

    expect(workerOutput).toEqual(directOutput);
    expect(workerOutput).toEqual({
      kind: "text",
      text: '{\n  "z": 1,\n  "items": [\n    true,\n    false\n  ]\n}',
    });
  });

  it("moves an adaptive input at the threshold into an exclusive Worker", async () => {
    const workers: FakeWorker[] = [];
    const manifest = manifestFor("adaptive");
    const executor = createExecutor(manifest, {
      workerFactory: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
      },
    });
    const input = "x".repeat(DEFAULT_ADAPTIVE_WORKER_THRESHOLD_BYTES);

    const task = executor.execute(textRequest(input));

    expect(task.location).toBe("worker");
    expect(workers).toHaveLength(1);
    expect(workers[0]?.postedMessage).toMatchObject({
      version: OPERATION_WORKER_PROTOCOL_VERSION,
      type: "execute",
      taskId: task.taskId,
      request: { operationId: manifest.id },
    });
    workers[0]?.respond({ kind: "text", text: "done" });
    await expect(task.promise).resolves.toEqual({ kind: "text", text: "done" });
    expect(workers[0]?.terminateCalls).toBe(1);
  });

  it("copies binary input before transfer so caller-owned bytes stay intact", async () => {
    const worker = new FakeWorker();
    const manifest = manifestFor("worker");
    const executor = createExecutor(manifest, { workerFactory: () => worker });
    const request = binaryRequest([10, 20, 30]);
    const callerBuffer =
      request.input.kind === "binary" ? request.input.data : new ArrayBuffer();

    const task = executor.execute(request);

    expect(callerBuffer.byteLength).toBe(3);
    expect([...new Uint8Array(callerBuffer)]).toEqual([10, 20, 30]);
    expect(worker.postedTransfer).toHaveLength(1);
    expect((worker.postedTransfer[0] as ArrayBuffer).byteLength).toBe(0);
    const workerInput = worker.postedMessage?.request.input;
    new Uint8Array(callerBuffer)[0] = 99;
    expect(workerInput?.kind).toBe("binary");
    if (workerInput?.kind === "binary") {
      expect([...new Uint8Array(workerInput.data)]).toEqual([10, 20, 30]);
      expect(workerInput.data).not.toBe(callerBuffer);
    }

    worker.respond({ kind: "binary", data: Uint8Array.from([30]).buffer });
    await expect(task.promise).resolves.toMatchObject({ kind: "binary" });
  });

  it("hard-cancels synchronously, terminates once, and rejects late settlement", async () => {
    const worker = new FakeWorker();
    const manifest = manifestFor("worker");
    const executor = createExecutor(manifest, { workerFactory: () => worker });
    const task = executor.execute(textRequest());

    expect(task.cancel()).toBe(true);
    expect(worker.terminateCalls).toBe(1);
    expect(task.cancel()).toBe(false);
    worker.respond({ kind: "text", text: "late" });
    await expect(task.promise).rejects.toMatchObject({
      code: "cancelled",
      operationId: manifest.id,
    });
    expect(worker.terminateCalls).toBe(1);
  });

  it("terminates a timed-out Worker and releases every tracked resource", async () => {
    const worker = new FakeWorker();
    const scheduler = new ManualScheduler();
    const manifest = manifestFor("worker");
    const executor = createExecutor(manifest, {
      workerFactory: () => worker,
      scheduler,
    });
    const task = executor.execute(textRequest("reserved"), { timeoutMs: 20 });
    expect(getActiveOperationMemoryBytes()).toBe(MEBIBYTE);

    scheduler.fire();

    expect(worker.terminateCalls).toBe(1);
    expect(getActiveOperationMemoryBytes()).toBe(0);
    await expect(task.promise).rejects.toMatchObject({ code: "timeout" });
  });

  it("recovers from a crash by using a fresh Worker for the next task", async () => {
    const workers: FakeWorker[] = [];
    const manifest = manifestFor("worker");
    const executor = createExecutor(manifest, {
      workerFactory: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
      },
    });

    const crashed = executor.execute(textRequest("first"));
    workers[0]?.crash();
    await expect(crashed.promise).rejects.toMatchObject({
      code: "worker-crashed",
    });

    const recovered = executor.execute(textRequest("second"));
    expect(workers).toHaveLength(2);
    expect(workers[1]).not.toBe(workers[0]);
    workers[1]?.respond({ kind: "text", text: "recovered" });
    await expect(recovered.promise).resolves.toMatchObject({
      text: "recovered",
    });
    expect(workers.map((worker) => worker.terminateCalls)).toEqual([1, 1]);
  });

  it("rejects malformed task IDs and oversized Worker output defensively", async () => {
    const workers: FakeWorker[] = [];
    const manifest = manifestFor("worker", {
      maxOutputBytes: 4,
      workingMemoryBytes: MEBIBYTE,
    });
    const executor = createExecutor(manifest, {
      workerFactory: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
      },
    });

    const malformed = executor.execute(textRequest());
    workers[0]?.onmessage?.({
      data: {
        version: OPERATION_WORKER_PROTOCOL_VERSION,
        type: "success",
        taskId: "another-task",
        output: { kind: "text", text: "ok" },
      },
    });
    await expect(malformed.promise).rejects.toMatchObject({
      code: "worker-crashed",
    });

    const oversized = executor.execute(textRequest());
    workers[1]?.respond({ kind: "text", text: "12345" });
    await expect(oversized.promise).rejects.toMatchObject({
      code: "output-too-large",
    });
    expect(workers.map((worker) => worker.terminateCalls)).toEqual([1, 1]);
  });

  it("propagates canonical Worker errors and handles factory failure", async () => {
    const worker = new FakeWorker();
    const manifest = manifestFor("worker");
    const executor = createExecutor(manifest, { workerFactory: () => worker });
    const rejected = executor.execute(textRequest());
    worker.fail(
      new OperationError("invalid-options", "Fixture options failed.", {
        operationId: "spoofed.operation",
      }),
    );
    await expect(rejected.promise).rejects.toMatchObject({
      code: "invalid-options",
      message: "Operation options are invalid.",
      operationId: manifest.id,
    });

    const broken = createExecutor(manifest, {
      workerFactory: () => {
        throw new Error("constructor failed");
      },
    });
    await expect(broken.execute(textRequest()).promise).rejects.toMatchObject({
      code: "worker-crashed",
    });
    expect(getActiveOperationMemoryBytes()).toBe(0);
  });
});

describe("Operation Worker protocol boundary", () => {
  it("rejects extra fields, accessors and oversized failure envelopes", () => {
    const baseFailure = {
      version: OPERATION_WORKER_PROTOCOL_VERSION,
      type: "failure",
      taskId: "fixture-1",
      error: {
        name: "OperationError",
        code: "execution-failed",
        message: "Operation execution failed.",
      },
    } as const;

    expect(isOperationWorkerResponseMessage(baseFailure)).toBe(true);
    expect(
      isOperationWorkerResponseMessage({ ...baseFailure, secret: "extra" }),
    ).toBe(false);
    expect(
      isOperationWorkerResponseMessage({
        ...baseFailure,
        error: {
          ...baseFailure.error,
          message: "x".repeat(MAX_OPERATION_WORKER_ERROR_MESSAGE_LENGTH + 1),
        },
      }),
    ).toBe(false);
    expect(
      isOperationWorkerResponseMessage({
        ...baseFailure,
        error: {
          ...baseFailure.error,
          details: {
            value: "x".repeat(MAX_OPERATION_WORKER_ERROR_DETAILS_BYTES),
          },
        },
      }),
    ).toBe(false);

    let getterCalls = 0;
    const errorWithAccessor = { ...baseFailure.error } as Record<
      string,
      unknown
    >;
    Object.defineProperty(errorWithAccessor, "message", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return "must not run";
      },
    });
    expect(
      isOperationWorkerResponseMessage({
        ...baseFailure,
        error: errorWithAccessor,
      }),
    ).toBe(false);
    expect(getterCalls).toBe(0);
  });

  it("does not expose Worker-provided messages, details or operation IDs", async () => {
    const secret = "OPERATION_WORKER_SECRET_7d21";
    const worker = new FakeWorker();
    const manifest = manifestFor("worker");
    const executor = createExecutor(manifest, { workerFactory: () => worker });
    const task = executor.execute(textRequest(secret));

    worker.onmessage?.({
      data: {
        version: OPERATION_WORKER_PROTOCOL_VERSION,
        type: "failure",
        taskId: worker.postedMessage?.taskId ?? "missing",
        error: {
          name: "OperationError",
          code: "execution-failed",
          message: secret,
          operationId: "spoofed.operation",
          details: { canary: secret },
        },
      },
    });

    try {
      await task.promise;
      throw new Error("Expected Worker execution to fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(OperationError);
      const serialized = JSON.stringify((error as OperationError).toJSON());
      expect(serialized).not.toContain(secret);
      expect(serialized).not.toContain("spoofed.operation");
      expect(error).toMatchObject({
        code: "execution-failed",
        operationId: manifest.id,
      });
    }
  });
});

describe("OperationExecutor global lifecycle", () => {
  it("admits the catalog's largest single-task memory declaration by default", async () => {
    const worker = new FakeWorker();
    const executor = createExecutor(IMAGE_OPERATION_MANIFEST, {
      workerFactory: () => worker,
    });
    const task = executor.execute({
      operationId: IMAGE_OPERATION_MANIFEST.id,
      input: {
        kind: "rgba-image",
        width: 1,
        height: 1,
        data: Uint8ClampedArray.from([0, 0, 0, 255]),
      },
    });

    expect(getActiveOperationMemoryBytes()).toBe(
      DEFAULT_MAX_ACTIVE_OPERATION_MEMORY_BYTES,
    );
    worker.respond({
      kind: "binary",
      data: Uint8Array.from([1]).buffer,
      mimeType: "image/png",
    });
    await expect(task.promise).resolves.toMatchObject({
      kind: "binary",
      mimeType: "image/png",
    });
  });

  it("releases admission slots when a data-only snapshot cannot be cloned", () => {
    const manifest = manifestFor("worker");
    const workerFactory = vi.fn(() => new FakeWorker());
    const executor = createExecutor(manifest, { workerFactory });
    const proxiedInput = new Proxy(
      { kind: "text" as const, text: "not cloneable" },
      {},
    );

    expect(() =>
      executor.execute({ operationId: manifest.id, input: proxiedInput }),
    ).toThrow(expect.objectContaining({ code: "type-mismatch" }));
    expect(workerFactory).not.toHaveBeenCalled();
    expect(getActiveOperationMemoryBytes()).toBe(0);
    expect(getActiveOperationTaskCount()).toBe(0);
    expect(getActiveOperationWorkerCount()).toBe(0);
  });

  it("bounds global task and Worker concurrency before creating more Workers", async () => {
    const manifest = manifestFor("worker");
    const workers: FakeWorker[] = [];
    const executor = createExecutor(manifest, {
      maxActiveTasks: 4,
      maxActiveWorkers: 1,
      workerFactory: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
      },
    });
    const first = executor.execute(textRequest("first"));

    expect(getActiveOperationTaskCount()).toBe(1);
    expect(getActiveOperationWorkerCount()).toBe(1);
    expect(() => executor.execute(textRequest("blocked"))).toThrow(
      expect.objectContaining({ code: "memory-budget" }),
    );
    expect(workers).toHaveLength(1);

    first.cancel();
    await expect(first.promise).rejects.toMatchObject({ code: "cancelled" });
    const admitted = executor.execute(textRequest("admitted"));
    expect(workers).toHaveLength(2);
    workers[1]?.respond({ kind: "text", text: "ok" });
    await expect(admitted.promise).resolves.toMatchObject({ text: "ok" });
  });

  it("bounds main-thread concurrency independently of the Worker limit", async () => {
    const manifest = manifestFor("main");
    let finish!: (output: OperationOutput) => void;
    const executor = createExecutor(manifest, {
      maxActiveTasks: 1,
      maxActiveWorkers: 0,
      loadDefinition: async () => ({
        manifest,
        execute: () =>
          new Promise<OperationOutput>((resolve) => {
            finish = resolve;
          }),
      }),
    });
    const first = executor.execute(textRequest("first"));

    expect(() => executor.execute(textRequest("blocked"))).toThrow(
      expect.objectContaining({ code: "memory-budget" }),
    );
    first.cancel();
    await expect(first.promise).rejects.toMatchObject({ code: "cancelled" });
    finish?.({ kind: "text", text: "late" });
  });

  it("enforces a process-wide working-memory budget across executors", async () => {
    const manifest = manifestFor("worker", {
      maxInputBytes: 6,
      maxOutputBytes: 6,
      workingMemoryBytes: 6,
    });
    const firstWorker = new FakeWorker();
    const secondWorker = new FakeWorker();
    const first = createExecutor(manifest, {
      maxActiveMemoryBytes: 10,
      workerFactory: () => firstWorker,
    });
    const second = createExecutor(manifest, {
      maxActiveMemoryBytes: 10,
      workerFactory: () => secondWorker,
    });
    const reserved = first.execute(binaryRequest([1, 2, 3, 4, 5, 6]));

    expect(() => second.execute(binaryRequest([1, 2, 3, 4, 5]))).toThrow(
      expect.objectContaining({ code: "memory-budget" }),
    );

    reserved.cancel();
    await expect(reserved.promise).rejects.toMatchObject({ code: "cancelled" });
    const admitted = second.execute(binaryRequest([1, 2, 3, 4, 5]));
    secondWorker.respond({ kind: "text", text: "ok" });
    await expect(admitted.promise).resolves.toMatchObject({ text: "ok" });
  });

  it("cancels all work on explicitly bound pagehide and detaches on dispose", async () => {
    const worker = new FakeWorker();
    const manifest = manifestFor("worker");
    const executor = createExecutor(manifest, { workerFactory: () => worker });
    const lifecycle = new PageLifecycleTarget();
    executor.bindPageHide(lifecycle);
    const task = executor.execute(textRequest());

    lifecycle.hide();

    expect(worker.terminateCalls).toBe(1);
    await expect(task.promise).rejects.toMatchObject({ code: "cancelled" });
    executor.dispose();
    expect(lifecycle.listener).toBeUndefined();
    expect(() => executor.execute(textRequest())).toThrow(
      expect.objectContaining({ code: "cancelled" }),
    );
  });

  it("fully cleans up when an AbortSignal shim throws during subscription and removal", async () => {
    const workerFactory = vi.fn(() => new FakeWorker());
    const manifest = manifestFor("worker");
    const executor = createExecutor(manifest, { workerFactory });
    const hostileSignal = {
      aborted: false,
      addEventListener() {
        throw new Error("subscription failed");
      },
      removeEventListener() {
        throw new Error("removal failed");
      },
    } as unknown as AbortSignal;

    const task = executor.execute(textRequest(), { signal: hostileSignal });

    await expect(task.promise).rejects.toMatchObject({
      code: "execution-failed",
    });
    expect(workerFactory).not.toHaveBeenCalled();
    expect(getActiveOperationMemoryBytes()).toBe(0);
    expect(getActiveOperationTaskCount()).toBe(0);
    expect(getActiveOperationWorkerCount()).toBe(0);
  });

  it("rejects unknown operations and invalid inputs before creating a Worker", () => {
    const workerFactory = vi.fn(() => new FakeWorker());
    const manifest = manifestFor("worker");
    const executor = createExecutor(manifest, { workerFactory });

    expect(() =>
      executor.execute({
        operationId: "missing.operation",
        input: { kind: "text", text: "secret" },
      }),
    ).toThrow(expect.objectContaining({ code: "unknown-operation" }));
    expect(() =>
      executor.execute({
        operationId: manifest.id,
        input: { kind: "empty" },
      }),
    ).toThrow(expect.objectContaining({ code: "type-mismatch" }));
    expect(workerFactory).not.toHaveBeenCalled();
  });
});

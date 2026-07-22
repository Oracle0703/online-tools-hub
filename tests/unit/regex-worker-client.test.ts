import { describe, expect, it, vi } from "vitest";

import {
  REGEX_TESTER_LIMITS,
  REGEX_WORKER_PROTOCOL_VERSION,
  type RegexTestInput,
  type RegexTestSuccess,
  type RegexWorkerExecuteMessage,
} from "../../src/tools/regex-tester/contract";
import {
  RegexWorkerClient,
  type RegexWorkerLike,
  type RegexWorkerMessageEvent,
  type RegexWorkerPageLifecycleTarget,
  type RegexWorkerScheduler,
} from "../../src/tools/regex-tester/worker-client";

const input: RegexTestInput = {
  pattern: ".",
  flags: "g",
  subject: "a",
};

const success: RegexTestSuccess = {
  ok: true,
  patternBytes: 1,
  subjectBytes: 1,
  flags: "g",
  matches: [],
  truncated: false,
  matchLimit: REGEX_TESTER_LIMITS.maxMatches,
  outputBytes: 128,
};

class FakeWorker implements RegexWorkerLike {
  onmessage: ((event: RegexWorkerMessageEvent) => void) | null = null;
  onerror: RegexWorkerLike["onerror"] = null;
  onmessageerror: RegexWorkerLike["onmessageerror"] = null;
  postedMessage: RegexWorkerExecuteMessage | undefined;
  terminateCalls = 0;
  throwOnPost = false;
  throwOnTerminate = false;

  postMessage(message: unknown): void {
    if (this.throwOnPost) throw new Error("private post failure");
    this.postedMessage = structuredClone(message) as RegexWorkerExecuteMessage;
  }

  terminate(): void {
    this.terminateCalls += 1;
    if (this.throwOnTerminate) throw new Error("private terminate failure");
  }

  emit(data: unknown): void {
    this.onmessage?.({ data });
  }
}

class FakeScheduler implements RegexWorkerScheduler {
  readonly callbacks = new Map<number, () => void>();
  readonly delays: number[] = [];
  clearCalls = 0;
  nextHandle = 0;
  throwOnClear = false;

  setTimeout(callback: () => void, timeoutMs: number): unknown {
    this.nextHandle += 1;
    this.callbacks.set(this.nextHandle, callback);
    this.delays.push(timeoutMs);
    return this.nextHandle;
  }

  clearTimeout(handle: unknown): void {
    this.clearCalls += 1;
    this.callbacks.delete(handle as number);
    if (this.throwOnClear) throw new Error("private clear failure");
  }

  fire(): void {
    for (const callback of [...this.callbacks.values()]) callback();
  }
}

class FakePageTarget implements RegexWorkerPageLifecycleTarget {
  listener: (() => void) | undefined;
  addCalls = 0;
  removeCalls = 0;

  addEventListener(_type: "pagehide", listener: () => void): void {
    this.addCalls += 1;
    this.listener = listener;
  }

  removeEventListener(_type: "pagehide", listener: () => void): void {
    if (this.listener !== listener) return;
    this.removeCalls += 1;
    this.listener = undefined;
  }

  pageHide(): void {
    this.listener?.();
  }
}

function response(taskId: string, result: RegexTestSuccess = success) {
  return {
    type: "REGEX_TEST_RESULT",
    protocol: REGEX_WORKER_PROTOCOL_VERSION,
    taskId,
    result,
  } as const;
}

function fixture(
  options: {
    scheduler?: FakeScheduler;
    worker?: FakeWorker;
    timeoutMs?: number;
  } = {},
) {
  const scheduler = options.scheduler ?? new FakeScheduler();
  const worker = options.worker ?? new FakeWorker();
  const client = new RegexWorkerClient({
    scheduler,
    workerFactory: () => worker,
    taskIdFactory: () => "regex-fixture-1",
    timeoutMs: options.timeoutMs,
  });
  return { client, scheduler, worker };
}

describe("regex Worker client", () => {
  it("posts one private snapshot and resolves a valid response", async () => {
    const { client, scheduler, worker } = fixture();
    const task = client.execute(input);

    expect(worker.postedMessage).toEqual({
      type: "REGEX_TEST_EXECUTE",
      protocol: REGEX_WORKER_PROTOCOL_VERSION,
      taskId: task.taskId,
      input,
    });
    worker.emit(response(task.taskId));

    await expect(task.result).resolves.toEqual(success);
    expect(client.snapshot()).toEqual({ active: false, disposed: false });
    expect(scheduler.callbacks.size).toBe(0);
    expect(worker.terminateCalls).toBe(1);
  });

  it("hard-terminates the Worker at the configured deadline", async () => {
    const { client, scheduler, worker } = fixture({ timeoutMs: 250 });
    const task = client.execute(input);
    const failure = task.result.catch((error: unknown) => error);

    expect(scheduler.delays).toEqual([250]);
    scheduler.fire();

    await expect(failure).resolves.toMatchObject({
      name: "RegexWorkerClientError",
      code: "timeout",
    });
    expect(worker.terminateCalls).toBe(1);
    expect(client.snapshot().active).toBe(false);
  });

  it("uses 2,000 ms as an immutable default ceiling", async () => {
    const { client, scheduler } = fixture({ timeoutMs: 10_000 });
    const task = client.execute(input);
    const failure = task.result.catch((error: unknown) => error);

    expect(scheduler.delays).toEqual([2_000]);
    scheduler.fire();
    await expect(failure).resolves.toMatchObject({ code: "timeout" });
  });

  it("rejects oversized input before creating or scheduling a Worker task", () => {
    const { client, scheduler, worker } = fixture();

    expect(() =>
      client.execute({
        ...input,
        pattern: "a".repeat(REGEX_TESTER_LIMITS.maxPatternBytes + 1),
      }),
    ).toThrow(expect.objectContaining({ code: "invalid-input" }));
    expect(() =>
      client.execute({
        ...input,
        subject: "a".repeat(REGEX_TESTER_LIMITS.maxSubjectBytes + 1),
      }),
    ).toThrow(expect.objectContaining({ code: "invalid-input" }));
    expect(worker.postedMessage).toBeUndefined();
    expect(worker.terminateCalls).toBe(0);
    expect(scheduler.delays).toEqual([]);
    expect(client.snapshot()).toEqual({ active: false, disposed: false });
  });

  it("cancels explicitly, rejects once and releases the busy slot", async () => {
    const { client, worker } = fixture();
    const task = client.execute(input);
    const failure = task.result.catch((error: unknown) => error);

    expect(() => client.execute(input)).toThrow(
      expect.objectContaining({ code: "busy" }),
    );
    expect(task.cancel()).toBe(true);
    expect(task.cancel()).toBe(false);
    await expect(failure).resolves.toMatchObject({ code: "cancelled" });
    expect(worker.terminateCalls).toBe(1);
    expect(client.snapshot().active).toBe(false);
  });

  it("rejects malformed, mismatched and unreadable Worker messages", async () => {
    const workers: FakeWorker[] = [];
    let sequence = 0;
    const client = new RegexWorkerClient({
      workerFactory: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
      },
      taskIdFactory: () => `regex-fixture-${++sequence}`,
    });

    const malformed = client.execute(input);
    workers[0]?.emit({ ...response(malformed.taskId), extra: "rejected" });
    await expect(malformed.result).rejects.toMatchObject({
      code: "invalid-response",
    });

    const mismatched = client.execute(input);
    workers[1]?.emit(response("regex-different-task"));
    await expect(mismatched.result).rejects.toMatchObject({
      code: "invalid-response",
    });

    const unreadable = client.execute(input);
    workers[2]?.onmessageerror?.({ data: "private payload" });
    await expect(unreadable.result).rejects.toMatchObject({
      code: "invalid-response",
    });
    expect(workers.every((worker) => worker.terminateCalls === 1)).toBe(true);
  });

  it("ignores a late response after the first result settles", async () => {
    const { client, worker } = fixture();
    const task = client.execute(input);
    const lateHandler = worker.onmessage;

    worker.emit(response(task.taskId));
    await expect(task.result).resolves.toEqual(success);
    lateHandler?.({ data: { private: "late malformed payload" } });

    expect(worker.terminateCalls).toBe(1);
    expect(client.snapshot().active).toBe(false);
  });

  it("releases task ownership when cleanup primitives throw", async () => {
    const scheduler = new FakeScheduler();
    scheduler.throwOnClear = true;
    const worker = new FakeWorker();
    worker.throwOnTerminate = true;
    const { client } = fixture({ scheduler, worker });
    const task = client.execute(input);

    worker.emit(response(task.taskId));

    await expect(task.result).resolves.toEqual(success);
    expect(client.snapshot()).toEqual({ active: false, disposed: false });
    expect(scheduler.clearCalls).toBe(1);
    expect(worker.terminateCalls).toBe(1);
  });

  it("cancels on pagehide and detaches the lifecycle listener on dispose", async () => {
    const { client, worker } = fixture();
    const target = new FakePageTarget();
    client.bindPageHide(target);
    const task = client.execute(input);
    const failure = task.result.catch((error: unknown) => error);

    target.pageHide();
    await expect(failure).resolves.toMatchObject({ code: "cancelled" });
    expect(worker.terminateCalls).toBe(1);

    client.dispose();
    client.dispose();
    expect(target.addCalls).toBe(1);
    expect(target.removeCalls).toBe(1);
    expect(target.listener).toBeUndefined();
    expect(client.snapshot()).toEqual({ active: false, disposed: true });
    expect(() => client.execute(input)).toThrow(
      expect.objectContaining({ code: "disposed" }),
    );
  });

  it("fails closed when posting to the Worker throws", async () => {
    const worker = new FakeWorker();
    worker.throwOnPost = true;
    const { client } = fixture({ worker });
    const task = client.execute(input);

    await expect(task.result).rejects.toMatchObject({ code: "worker-failed" });
    expect(worker.terminateCalls).toBe(1);
    expect(client.snapshot().active).toBe(false);
  });

  it("canonicalizes Worker factory failures without reserving a task", () => {
    const secret = "PRIVATE_FACTORY_CANARY_74b2";
    const client = new RegexWorkerClient({
      workerFactory() {
        throw new Error(secret);
      },
      taskIdFactory: () => "regex-fixture-factory",
    });

    let failure: unknown;
    try {
      client.execute(input);
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      name: "RegexWorkerClientError",
      code: "unavailable",
    });
    expect(JSON.stringify(failure)).not.toContain(secret);
    expect(client.snapshot()).toEqual({ active: false, disposed: false });
  });

  it("prevents a Worker error from leaking its native message", async () => {
    const { client, worker } = fixture();
    const task = client.execute(input);
    const preventDefault = vi.fn();

    worker.onerror?.({
      message: "PRIVATE_WORKER_CANARY_03f9",
      preventDefault,
    });

    const error = await task.result.catch((failure: unknown) => failure);
    expect(error).toMatchObject({ code: "worker-failed" });
    expect(JSON.stringify(error)).not.toContain("PRIVATE_WORKER_CANARY_03f9");
    expect(preventDefault).toHaveBeenCalledOnce();
  });
});

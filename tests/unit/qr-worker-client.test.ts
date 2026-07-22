import { describe, expect, it, vi } from "vitest";

import {
  getQrTextByteLength,
  QR_CODE_LIMITS,
  QR_WORKER_PROTOCOL_VERSION,
  type QrGenerateInput,
  type QrGenerateSuccess,
  type QrScanSuccess,
  type QrWorkerExecuteMessage,
} from "../../src/tools/qr-code/contract";
import {
  QrWorkerClient,
  type QrWorkerLike,
  type QrWorkerMessageEvent,
  type QrWorkerPageLifecycleTarget,
  type QrWorkerScheduler,
} from "../../src/tools/qr-code/worker-client";

const input: QrGenerateInput = {
  mode: "generate",
  text: "hello",
  ecc: "M",
  displaySize: 256,
};

const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 29 29" shape-rendering="crispEdges"><rect width="29" height="29" fill="#ffffff"/><path d="" fill="#0f172a"/></svg>';
const generateSuccess: QrGenerateSuccess = {
  ok: true,
  mode: "generate",
  svg,
  version: 1,
  modules: 29,
  ecc: "M",
  displaySize: 256,
  textBytes: 5,
  outputBytes: getQrTextByteLength(svg),
};

const scanSuccess: QrScanSuccess = {
  ok: true,
  mode: "scan",
  text: "https://example.invalid/private",
  textBytes: getQrTextByteLength("https://example.invalid/private"),
  version: 1,
};

class FakeWorker implements QrWorkerLike {
  onmessage: ((event: QrWorkerMessageEvent) => void) | null = null;
  onerror: QrWorkerLike["onerror"] = null;
  onmessageerror: QrWorkerLike["onmessageerror"] = null;
  postedMessage: QrWorkerExecuteMessage | undefined;
  postedTransfers: Transferable[] = [];
  terminateCalls = 0;
  throwOnPost = false;

  postMessage(message: unknown, transfer: Transferable[] = []): void {
    if (this.throwOnPost) throw new Error("private post failure");
    this.postedTransfers = [...transfer];
    this.postedMessage = structuredClone(message, {
      transfer,
    }) as QrWorkerExecuteMessage;
  }

  terminate(): void {
    this.terminateCalls += 1;
  }

  emit(data: unknown): void {
    this.onmessage?.({ data });
  }
}

class FakeScheduler implements QrWorkerScheduler {
  readonly callbacks = new Map<number, () => void>();
  readonly delays: number[] = [];
  clearCalls = 0;
  nextHandle = 0;

  setTimeout(callback: () => void, timeoutMs: number): unknown {
    this.nextHandle += 1;
    this.callbacks.set(this.nextHandle, callback);
    this.delays.push(timeoutMs);
    return this.nextHandle;
  }

  clearTimeout(handle: unknown): void {
    this.clearCalls += 1;
    this.callbacks.delete(handle as number);
  }

  fire(): void {
    for (const callback of [...this.callbacks.values()]) callback();
  }
}

class FakePageTarget implements QrWorkerPageLifecycleTarget {
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

function response(
  taskId: string,
  result: QrGenerateSuccess | QrScanSuccess = generateSuccess,
) {
  return {
    type: "QR_CODE_RESULT",
    protocol: QR_WORKER_PROTOCOL_VERSION,
    taskId,
    result,
  } as const;
}

function fixture(options: { timeoutMs?: number } = {}) {
  const scheduler = new FakeScheduler();
  const worker = new FakeWorker();
  const client = new QrWorkerClient({
    scheduler,
    workerFactory: () => worker,
    taskIdFactory: () => "qr-fixture-1",
    timeoutMs: options.timeoutMs,
  });
  return { client, scheduler, worker };
}

describe("QR Worker client", () => {
  it("posts one private snapshot, resolves success and terminates", async () => {
    const { client, scheduler, worker } = fixture();
    const task = client.execute(input);

    expect(worker.postedMessage).toEqual({
      type: "QR_CODE_EXECUTE",
      protocol: QR_WORKER_PROTOCOL_VERSION,
      taskId: task.taskId,
      input,
    });
    expect(worker.postedTransfers).toEqual([]);
    worker.emit(response(task.taskId));

    await expect(task.result).resolves.toEqual(generateSuccess);
    expect(client.snapshot()).toEqual({ active: false, disposed: false });
    expect(scheduler.callbacks.size).toBe(0);
    expect(worker.terminateCalls).toBe(1);
  });

  it("transfers RGBA ownership instead of copying it", async () => {
    const { client, worker } = fixture();
    const rgba = new Uint8ClampedArray([255, 255, 255, 255]).buffer;
    const task = client.execute({
      mode: "scan",
      rgba,
      width: 1,
      height: 1,
      inversionAttempts: "attemptBoth",
    });

    expect(worker.postedTransfers).toHaveLength(1);
    expect(rgba.byteLength).toBe(0);
    expect(worker.postedMessage?.input.mode).toBe("scan");
    if (worker.postedMessage?.input.mode !== "scan") {
      throw new Error("Scan request was not posted.");
    }
    expect(worker.postedMessage.input.rgba.byteLength).toBe(4);

    worker.emit(response(task.taskId, scanSuccess));
    await expect(task.result).resolves.toEqual(scanSuccess);
    expect(worker.terminateCalls).toBe(1);
  });

  it("hard-terminates at the configured timeout with an 8 second ceiling", async () => {
    const short = fixture({ timeoutMs: 250 });
    const shortTask = short.client.execute(input);
    const shortFailure = shortTask.result.catch((error: unknown) => error);

    expect(short.scheduler.delays).toEqual([250]);
    short.scheduler.fire();
    await expect(shortFailure).resolves.toMatchObject({ code: "timeout" });
    expect(short.worker.terminateCalls).toBe(1);
    expect(short.client.snapshot().active).toBe(false);

    const capped = fixture({ timeoutMs: 60_000 });
    const cappedTask = capped.client.execute(input);
    const cappedFailure = cappedTask.result.catch((error: unknown) => error);
    expect(capped.scheduler.delays).toEqual([8_000]);
    capped.scheduler.fire();
    await expect(cappedFailure).resolves.toMatchObject({ code: "timeout" });
    expect(capped.worker.terminateCalls).toBe(1);
  });

  it("rejects malformed and mismatched responses and terminates", async () => {
    const workers: FakeWorker[] = [];
    let sequence = 0;
    const client = new QrWorkerClient({
      workerFactory: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
      },
      taskIdFactory: () => `qr-fixture-${++sequence}`,
    });

    const malformed = client.execute(input);
    workers[0]?.emit({ ...response(malformed.taskId), extra: "rejected" });
    await expect(malformed.result).rejects.toMatchObject({
      code: "invalid-response",
    });

    const mismatched = client.execute(input);
    workers[1]?.emit(response("qr-different-task"));
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

  it("cancels once, releases the busy slot and terminates", async () => {
    const { client, worker } = fixture();
    const task = client.execute(input);
    const failure = task.result.catch((error: unknown) => error);

    expect(() => client.execute(input)).toThrow(
      expect.objectContaining({ code: "busy" }),
    );
    expect(task.cancel()).toBe(true);
    expect(task.cancel()).toBe(false);
    await expect(failure).resolves.toMatchObject({ code: "cancelled" });
    expect(client.snapshot().active).toBe(false);
    expect(worker.terminateCalls).toBe(1);
  });

  it("cancels on pagehide and removes the listener on dispose", async () => {
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
  });

  it("rejects oversized input before creating, transferring or scheduling", () => {
    const { client, scheduler, worker } = fixture();

    expect(() =>
      client.execute({
        ...input,
        text: "x".repeat(QR_CODE_LIMITS.maxTextBytes + 1),
      }),
    ).toThrow(expect.objectContaining({ code: "invalid-input" }));
    expect(() =>
      client.execute({
        mode: "scan",
        rgba: new ArrayBuffer(0),
        width: 2_001,
        height: 2_000,
        inversionAttempts: "attemptBoth",
      }),
    ).toThrow(expect.objectContaining({ code: "invalid-input" }));

    expect(worker.postedMessage).toBeUndefined();
    expect(worker.postedTransfers).toEqual([]);
    expect(worker.terminateCalls).toBe(0);
    expect(scheduler.delays).toEqual([]);
  });

  it("fails closed on Worker errors without leaking their native message", async () => {
    const { client, worker } = fixture();
    const task = client.execute(input);
    const preventDefault = vi.fn();

    worker.onerror?.({
      message: "QR_PRIVATE_WORKER_CANARY_03f9",
      preventDefault,
    });

    const error = await task.result.catch((failure: unknown) => failure);
    expect(error).toMatchObject({ code: "worker-failed" });
    expect(JSON.stringify(error)).not.toContain(
      "QR_PRIVATE_WORKER_CANARY_03f9",
    );
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(worker.terminateCalls).toBe(1);
  });
});

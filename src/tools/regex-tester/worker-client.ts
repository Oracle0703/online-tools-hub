import {
  getRegexTextByteLength,
  isRegexWorkerResultMessage,
  REGEX_TESTER_LIMITS,
  REGEX_WORKER_PROTOCOL_VERSION,
  type RegexTestInput,
  type RegexTestResult,
  type RegexWorkerExecuteMessage,
} from "./contract";

export const REGEX_WORKER_TIMEOUT_MS = 2_000;

export interface RegexWorkerMessageEvent {
  readonly data: unknown;
}

export interface RegexWorkerErrorEvent {
  readonly message?: string;
  preventDefault?(): void;
}

export interface RegexWorkerLike {
  onmessage: ((event: RegexWorkerMessageEvent) => void) | null;
  onerror: ((event: RegexWorkerErrorEvent) => void) | null;
  onmessageerror: ((event: RegexWorkerMessageEvent) => void) | null;
  postMessage(message: unknown): void;
  terminate(): void;
}

export interface RegexWorkerScheduler {
  setTimeout(callback: () => void, timeoutMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface RegexWorkerPageLifecycleTarget {
  addEventListener(type: "pagehide", listener: () => void): void;
  removeEventListener(type: "pagehide", listener: () => void): void;
}

export interface RegexWorkerClientOptions {
  readonly workerFactory?: () => RegexWorkerLike;
  readonly scheduler?: RegexWorkerScheduler;
  readonly taskIdFactory?: () => string;
  readonly timeoutMs?: number;
}

export type RegexWorkerClientErrorCode =
  | "busy"
  | "cancelled"
  | "invalid-input"
  | "timeout"
  | "unavailable"
  | "worker-failed"
  | "invalid-response"
  | "disposed";

export class RegexWorkerClientError extends Error {
  readonly code: RegexWorkerClientErrorCode;

  constructor(code: RegexWorkerClientErrorCode, message: string) {
    super(message);
    this.name = "RegexWorkerClientError";
    this.code = code;
  }
}

export interface RegexWorkerTask {
  readonly taskId: string;
  readonly result: Promise<RegexTestResult>;
  cancel(): boolean;
}

interface ActiveTask {
  readonly taskId: string;
  readonly worker: RegexWorkerLike;
  readonly resolve: (result: RegexTestResult) => void;
  readonly reject: (error: RegexWorkerClientError) => void;
  timeoutHandle: unknown;
  settled: boolean;
}

let taskSequence = 0;

const browserScheduler: RegexWorkerScheduler = {
  setTimeout(callback, timeoutMs) {
    return globalThis.setTimeout(callback, timeoutMs);
  },
  clearTimeout(handle) {
    globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>);
  },
};

function createBrowserWorker(): RegexWorkerLike {
  if (typeof Worker === "undefined") {
    throw new RegexWorkerClientError(
      "unavailable",
      "当前浏览器不支持独立 Worker，正则测试已安全停止。",
    );
  }
  return new Worker(
    new URL("../../workers/regex-tester.worker.ts", import.meta.url),
    { type: "module", name: "online-tools-regex-tester" },
  ) as unknown as RegexWorkerLike;
}

function defaultTaskIdFactory() {
  taskSequence += 1;
  return `regex-${Date.now().toString(36)}-${taskSequence.toString(36)}`;
}

export class RegexWorkerClient {
  private readonly workerFactory: () => RegexWorkerLike;
  private readonly scheduler: RegexWorkerScheduler;
  private readonly taskIdFactory: () => string;
  private readonly timeoutMs: number;
  private activeTask: ActiveTask | null = null;
  private pageTarget: RegexWorkerPageLifecycleTarget | null = null;
  private disposed = false;

  private readonly pageHideListener = () => {
    this.cancel();
  };

  constructor(options: RegexWorkerClientOptions = {}) {
    this.workerFactory = options.workerFactory ?? createBrowserWorker;
    this.scheduler = options.scheduler ?? browserScheduler;
    this.taskIdFactory = options.taskIdFactory ?? defaultTaskIdFactory;
    const requestedTimeout = options.timeoutMs ?? REGEX_WORKER_TIMEOUT_MS;
    this.timeoutMs =
      Number.isSafeInteger(requestedTimeout) && requestedTimeout > 0
        ? Math.min(REGEX_WORKER_TIMEOUT_MS, requestedTimeout)
        : REGEX_WORKER_TIMEOUT_MS;
  }

  private cleanupTask(active: ActiveTask): void {
    try {
      this.scheduler.clearTimeout(active.timeoutHandle);
    } catch {
      // Cleanup is best-effort; task ownership is still released below.
    }
    try {
      active.worker.onmessage = null;
      active.worker.onerror = null;
      active.worker.onmessageerror = null;
    } catch {
      // A hostile test double must not keep the task reserved.
    }
    try {
      active.worker.terminate();
    } catch {
      // Browser Worker#terminate is normally infallible. Continue fail-closed.
    }
    if (this.activeTask === active) this.activeTask = null;
  }

  bindPageHide(target: RegexWorkerPageLifecycleTarget): void {
    if (this.disposed || this.pageTarget === target) return;
    if (this.pageTarget) {
      this.pageTarget.removeEventListener("pagehide", this.pageHideListener);
    }
    this.pageTarget = target;
    target.addEventListener("pagehide", this.pageHideListener);
  }

  execute(input: RegexTestInput): RegexWorkerTask {
    if (this.disposed) {
      throw new RegexWorkerClientError(
        "disposed",
        "正则 Worker 控制器已经释放。",
      );
    }
    if (this.activeTask) {
      throw new RegexWorkerClientError(
        "busy",
        "已有正则测试正在运行，请先取消。",
      );
    }
    if (
      typeof input?.pattern !== "string" ||
      typeof input?.flags !== "string" ||
      typeof input?.subject !== "string"
    ) {
      throw new RegexWorkerClientError(
        "invalid-input",
        "正则测试输入结构无效，任务未启动。",
      );
    }
    if (
      getRegexTextByteLength(input.pattern) >
      REGEX_TESTER_LIMITS.maxPatternBytes
    ) {
      throw new RegexWorkerClientError(
        "invalid-input",
        "pattern 超过 8 KiB 上限，任务未启动。",
      );
    }
    if (
      getRegexTextByteLength(input.subject) >
      REGEX_TESTER_LIMITS.maxSubjectBytes
    ) {
      throw new RegexWorkerClientError(
        "invalid-input",
        "测试文本超过 256 KiB 上限，任务未启动。",
      );
    }

    const taskId = this.taskIdFactory();
    if (!/^regex-[A-Za-z0-9_-]{1,96}$/u.test(taskId)) {
      throw new RegexWorkerClientError(
        "unavailable",
        "无法建立安全的正则测试任务。",
      );
    }
    let worker: RegexWorkerLike;
    try {
      worker = this.workerFactory();
    } catch {
      throw new RegexWorkerClientError(
        "unavailable",
        "无法创建独立正则 Worker，任务已安全停止。",
      );
    }
    let resolveTask!: (result: RegexTestResult) => void;
    let rejectTask!: (error: RegexWorkerClientError) => void;
    const result = new Promise<RegexTestResult>((resolve, reject) => {
      resolveTask = resolve;
      rejectTask = reject;
    });
    const active: ActiveTask = {
      taskId,
      worker,
      resolve: resolveTask,
      reject: rejectTask,
      timeoutHandle: undefined,
      settled: false,
    };
    this.activeTask = active;

    const settle = (
      outcome:
        | { readonly result: RegexTestResult }
        | { readonly error: RegexWorkerClientError },
    ) => {
      if (active.settled) return;
      active.settled = true;
      this.cleanupTask(active);
      if ("result" in outcome) active.resolve(outcome.result);
      else active.reject(outcome.error);
    };

    try {
      worker.onmessage = (event) => {
        if (!isRegexWorkerResultMessage(event.data, taskId)) {
          settle({
            error: new RegexWorkerClientError(
              "invalid-response",
              "正则 Worker 返回了无效结果，任务已安全停止。",
            ),
          });
          return;
        }
        settle({ result: event.data.result });
      };
      worker.onerror = (event) => {
        event.preventDefault?.();
        settle({
          error: new RegexWorkerClientError(
            "worker-failed",
            "正则 Worker 运行失败，输入未被保留。",
          ),
        });
      };
      worker.onmessageerror = () => {
        settle({
          error: new RegexWorkerClientError(
            "invalid-response",
            "正则 Worker 结果无法读取，任务已安全停止。",
          ),
        });
      };
      const request: RegexWorkerExecuteMessage = {
        type: "REGEX_TEST_EXECUTE",
        protocol: REGEX_WORKER_PROTOCOL_VERSION,
        taskId,
        input,
      };
      active.timeoutHandle = this.scheduler.setTimeout(() => {
        settle({
          error: new RegexWorkerClientError(
            "timeout",
            "正则执行超过 2 秒，Worker 已被强制终止以阻断 ReDoS。",
          ),
        });
      }, this.timeoutMs);
      worker.postMessage(request);
    } catch {
      settle({
        error: new RegexWorkerClientError(
          "worker-failed",
          "无法启动正则 Worker，任务已安全停止。",
        ),
      });
    }

    return {
      taskId,
      result,
      cancel: () => this.cancel(taskId),
    };
  }

  cancel(expectedTaskId?: string): boolean {
    const active = this.activeTask;
    if (!active || (expectedTaskId && active.taskId !== expectedTaskId)) {
      return false;
    }
    if (active.settled) return false;
    active.settled = true;
    this.cleanupTask(active);
    active.reject(
      new RegexWorkerClientError(
        "cancelled",
        "正则测试已取消，Worker 和临时结果已释放。",
      ),
    );
    return true;
  }

  snapshot() {
    return Object.freeze({
      active: this.activeTask !== null,
      disposed: this.disposed,
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.cancel();
    if (this.pageTarget) {
      try {
        this.pageTarget.removeEventListener("pagehide", this.pageHideListener);
      } catch {
        // Releasing the local reference is sufficient to fail closed.
      }
      this.pageTarget = null;
    }
    this.disposed = true;
  }
}

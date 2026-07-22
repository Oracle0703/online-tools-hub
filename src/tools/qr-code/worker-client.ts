import {
  getQrTextByteLength,
  isQrWorkerResultMessage,
  QR_CODE_LIMITS,
  QR_DISPLAY_SIZES,
  QR_ERROR_CORRECTION_LEVELS,
  QR_INVERSION_ATTEMPTS,
  QR_WORKER_PROTOCOL_VERSION,
  type QrCodeResult,
  type QrWorkerExecuteMessage,
  type QrWorkerInput,
} from "./contract";

export const QR_WORKER_TIMEOUT_MS = 8_000;

export interface QrWorkerMessageEvent {
  readonly data: unknown;
}

export interface QrWorkerErrorEvent {
  readonly message?: string;
  preventDefault?(): void;
}

export interface QrWorkerLike {
  onmessage: ((event: QrWorkerMessageEvent) => void) | null;
  onerror: ((event: QrWorkerErrorEvent) => void) | null;
  onmessageerror: ((event: QrWorkerMessageEvent) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
}

export interface QrWorkerScheduler {
  setTimeout(callback: () => void, timeoutMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface QrWorkerPageLifecycleTarget {
  addEventListener(type: "pagehide", listener: () => void): void;
  removeEventListener(type: "pagehide", listener: () => void): void;
}

export interface QrWorkerClientOptions {
  readonly workerFactory?: () => QrWorkerLike;
  readonly scheduler?: QrWorkerScheduler;
  readonly taskIdFactory?: () => string;
  readonly timeoutMs?: number;
}

export type QrWorkerClientErrorCode =
  | "busy"
  | "cancelled"
  | "invalid-input"
  | "timeout"
  | "unavailable"
  | "worker-failed"
  | "invalid-response"
  | "disposed";

export class QrWorkerClientError extends Error {
  readonly code: QrWorkerClientErrorCode;

  constructor(code: QrWorkerClientErrorCode, message: string) {
    super(message);
    this.name = "QrWorkerClientError";
    this.code = code;
  }
}

export interface QrWorkerTask {
  readonly taskId: string;
  readonly result: Promise<QrCodeResult>;
  cancel(): boolean;
}

interface ActiveTask {
  readonly taskId: string;
  readonly worker: QrWorkerLike;
  readonly resolve: (result: QrCodeResult) => void;
  readonly reject: (error: QrWorkerClientError) => void;
  timeoutHandle: unknown;
  settled: boolean;
}

let taskSequence = 0;

const browserScheduler: QrWorkerScheduler = {
  setTimeout(callback, timeoutMs) {
    return globalThis.setTimeout(callback, timeoutMs);
  },
  clearTimeout(handle) {
    globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>);
  },
};

function createBrowserWorker(): QrWorkerLike {
  if (typeof Worker === "undefined") {
    throw new QrWorkerClientError(
      "unavailable",
      "当前浏览器不支持独立 Worker，二维码任务已安全停止。",
    );
  }
  return new Worker(
    new URL("../../workers/qr-code.worker.ts", import.meta.url),
    {
      type: "module",
      name: "online-tools-qr-code",
    },
  ) as unknown as QrWorkerLike;
}

function defaultTaskIdFactory() {
  taskSequence += 1;
  return `qr-${Date.now().toString(36)}-${taskSequence.toString(36)}`;
}

function assertValidInput(input: QrWorkerInput): void {
  if (input?.mode === "generate") {
    if (
      typeof input.text !== "string" ||
      input.text.length > QR_CODE_LIMITS.maxTextBytes ||
      getQrTextByteLength(input.text) > QR_CODE_LIMITS.maxTextBytes ||
      !QR_ERROR_CORRECTION_LEVELS.includes(input.ecc) ||
      !QR_DISPLAY_SIZES.includes(input.displaySize)
    ) {
      throw new QrWorkerClientError(
        "invalid-input",
        "二维码生成输入无效，任务未启动。",
      );
    }
    return;
  }

  if (
    input?.mode !== "scan" ||
    !(input.rgba instanceof ArrayBuffer) ||
    !Number.isSafeInteger(input.width) ||
    !Number.isSafeInteger(input.height) ||
    input.width <= 0 ||
    input.height <= 0 ||
    input.width > QR_CODE_LIMITS.maxSourceEdge ||
    input.height > QR_CODE_LIMITS.maxSourceEdge ||
    input.width * input.height > QR_CODE_LIMITS.maxScanPixels ||
    input.rgba.byteLength !== input.width * input.height * 4 ||
    !QR_INVERSION_ATTEMPTS.includes(input.inversionAttempts)
  ) {
    throw new QrWorkerClientError(
      "invalid-input",
      "二维码识别像素无效，任务未启动。",
    );
  }
}

export class QrWorkerClient {
  private readonly workerFactory: () => QrWorkerLike;
  private readonly scheduler: QrWorkerScheduler;
  private readonly taskIdFactory: () => string;
  private readonly timeoutMs: number;
  private activeTask: ActiveTask | null = null;
  private pageTarget: QrWorkerPageLifecycleTarget | null = null;
  private disposed = false;

  private readonly pageHideListener = () => {
    this.cancel();
  };

  constructor(options: QrWorkerClientOptions = {}) {
    this.workerFactory = options.workerFactory ?? createBrowserWorker;
    this.scheduler = options.scheduler ?? browserScheduler;
    this.taskIdFactory = options.taskIdFactory ?? defaultTaskIdFactory;
    const requestedTimeout = options.timeoutMs ?? QR_WORKER_TIMEOUT_MS;
    this.timeoutMs =
      Number.isSafeInteger(requestedTimeout) && requestedTimeout > 0
        ? Math.min(QR_WORKER_TIMEOUT_MS, requestedTimeout)
        : QR_WORKER_TIMEOUT_MS;
  }

  private cleanupTask(active: ActiveTask): void {
    try {
      this.scheduler.clearTimeout(active.timeoutHandle);
    } catch {
      // Ownership is still released below.
    }
    try {
      active.worker.onmessage = null;
      active.worker.onerror = null;
      active.worker.onmessageerror = null;
    } catch {
      // A hostile test double must not retain the task.
    }
    try {
      active.worker.terminate();
    } catch {
      // Continue fail-closed if Worker cleanup itself throws.
    }
    if (this.activeTask === active) this.activeTask = null;
  }

  bindPageHide(target: QrWorkerPageLifecycleTarget): void {
    if (this.disposed || this.pageTarget === target) return;
    if (this.pageTarget) {
      this.pageTarget.removeEventListener("pagehide", this.pageHideListener);
    }
    this.pageTarget = target;
    target.addEventListener("pagehide", this.pageHideListener);
  }

  execute(input: QrWorkerInput): QrWorkerTask {
    if (this.disposed) {
      throw new QrWorkerClientError(
        "disposed",
        "二维码 Worker 控制器已经释放。",
      );
    }
    if (this.activeTask) {
      throw new QrWorkerClientError(
        "busy",
        "已有二维码任务正在运行，请先取消。",
      );
    }
    assertValidInput(input);

    const taskId = this.taskIdFactory();
    if (!/^qr-[A-Za-z0-9_-]{1,96}$/u.test(taskId)) {
      throw new QrWorkerClientError(
        "unavailable",
        "无法建立安全的二维码任务。",
      );
    }

    let worker: QrWorkerLike;
    try {
      worker = this.workerFactory();
    } catch {
      throw new QrWorkerClientError(
        "unavailable",
        "无法创建独立二维码 Worker，任务已安全停止。",
      );
    }

    let resolveTask!: (result: QrCodeResult) => void;
    let rejectTask!: (error: QrWorkerClientError) => void;
    const result = new Promise<QrCodeResult>((resolve, reject) => {
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
        | { readonly result: QrCodeResult }
        | { readonly error: QrWorkerClientError },
    ) => {
      if (active.settled) return;
      active.settled = true;
      this.cleanupTask(active);
      if ("result" in outcome) active.resolve(outcome.result);
      else active.reject(outcome.error);
    };

    try {
      worker.onmessage = (event) => {
        if (
          !isQrWorkerResultMessage(event.data, taskId) ||
          (event.data.result.ok && event.data.result.mode !== input.mode)
        ) {
          settle({
            error: new QrWorkerClientError(
              "invalid-response",
              "二维码 Worker 返回了无效结果，任务已安全停止。",
            ),
          });
          return;
        }
        settle({ result: event.data.result });
      };
      worker.onerror = (event) => {
        event.preventDefault?.();
        settle({
          error: new QrWorkerClientError(
            "worker-failed",
            "二维码 Worker 运行失败，输入未被保留。",
          ),
        });
      };
      worker.onmessageerror = () => {
        settle({
          error: new QrWorkerClientError(
            "invalid-response",
            "二维码 Worker 结果无法读取，任务已安全停止。",
          ),
        });
      };

      const request: QrWorkerExecuteMessage = {
        type: "QR_CODE_EXECUTE",
        protocol: QR_WORKER_PROTOCOL_VERSION,
        taskId,
        input,
      };
      active.timeoutHandle = this.scheduler.setTimeout(() => {
        settle({
          error: new QrWorkerClientError(
            "timeout",
            "二维码处理超过 8 秒，Worker 已被强制终止。",
          ),
        });
      }, this.timeoutMs);
      worker.postMessage(request, input.mode === "scan" ? [input.rgba] : []);
    } catch {
      settle({
        error: new QrWorkerClientError(
          "worker-failed",
          "无法启动二维码 Worker，任务已安全停止。",
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
      new QrWorkerClientError(
        "cancelled",
        "二维码任务已取消，Worker 和临时结果已释放。",
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

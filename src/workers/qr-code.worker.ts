import {
  isQrWorkerExecuteMessage,
  QR_WORKER_PROTOCOL_VERSION,
  type QrWorkerResultMessage,
} from "../tools/qr-code/contract";
import { installOperationWorkerPrivacyGuards } from "../operations/privacy-guard";

interface QrWorkerScope {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(message: QrWorkerResultMessage): void;
}

const workerScope = globalThis as unknown as QrWorkerScope;

// GitHub Pages cannot attach a CSP response header to a module Worker. Block
// ambient network and persistence capabilities before accepting any payload.
installOperationWorkerPrivacyGuards(globalThis);
let acceptedTask = false;

workerScope.onmessage = (event) => {
  if (acceptedTask) return;
  acceptedTask = true;
  const request = event.data;
  if (!isQrWorkerExecuteMessage(request)) {
    postFailure(
      readTaskId(request),
      "invalid-input",
      "二维码 Worker 收到无效请求，任务已安全停止。",
    );
    return;
  }
  void executeTask(request.taskId, request.input).catch(() => {
    postFailure(
      request.taskId,
      request.input.mode === "generate" ? "generation-failed" : "scan-failed",
      "二维码 Worker 执行失败，临时输入已释放。",
    );
  });
};

async function executeTask(
  taskId: string,
  input: import("../tools/qr-code/contract").QrWorkerInput,
) {
  const { transformQrCode } = await import("../tools/qr-code/core");
  const response: QrWorkerResultMessage = {
    type: "QR_CODE_RESULT",
    protocol: QR_WORKER_PROTOCOL_VERSION,
    taskId,
    result: transformQrCode(input),
  };
  workerScope.postMessage(response);
}

function postFailure(
  taskId: string,
  code: "invalid-input" | "generation-failed" | "scan-failed",
  message: string,
): void {
  workerScope.postMessage({
    type: "QR_CODE_RESULT",
    protocol: QR_WORKER_PROTOCOL_VERSION,
    taskId,
    result: { ok: false, error: { code, message } },
  });
}

function readTaskId(value: unknown): string {
  if (value !== null && typeof value === "object") {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(value, "taskId");
      if (
        descriptor &&
        "value" in descriptor &&
        typeof descriptor.value === "string" &&
        /^qr-[A-Za-z0-9_-]{1,96}$/u.test(descriptor.value)
      ) {
        return descriptor.value;
      }
    } catch {
      // Use the fixed non-sensitive fallback below.
    }
  }
  return "qr-invalid";
}

export {};

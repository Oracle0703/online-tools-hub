export const PWA_OFFLINE_PROTOCOL_VERSION = 1 as const;

const requestIdPattern = /^[A-Za-z0-9_-]{1,128}$/u;
const DEFAULT_RESPONSE_TIMEOUT_MS = 12_000;
const DEFAULT_DOWNLOAD_INACTIVITY_TIMEOUT_MS = 60_000;

export const offlinePackageErrorCodes = [
  "busy",
  "cancelled",
  "network",
  "integrity",
  "quota",
  "cache",
  "invalid-request",
  "unsupported-protocol",
] as const;

export type OfflinePackageErrorCode = (typeof offlinePackageErrorCodes)[number];
export type OfflinePackageState = "shell" | "partial" | "complete";
export type OfflinePackageProgressPhase = "checking" | "downloading";

export type OfflinePackageStatus = {
  type:
    | "PWA_OFFLINE_STATUS"
    | "PWA_OFFLINE_COMPLETE"
    | "PWA_OFFLINE_CANCELLED"
    | "PWA_OFFLINE_REMOVED";
  protocol: typeof PWA_OFFLINE_PROTOCOL_VERSION;
  requestId: string;
  buildVersion: string;
  state: OfflinePackageState;
  cachedEntries: number;
  cachedBytes: number;
  missingEntries: number;
  missingBytes: number;
  totalEntries: number;
  totalBytes: number;
};

export type OfflinePackageProgress = {
  type: "PWA_OFFLINE_PROGRESS";
  protocol: typeof PWA_OFFLINE_PROTOCOL_VERSION;
  requestId: string;
  buildVersion: string;
  phase: OfflinePackageProgressPhase;
  processedEntries: number;
  cachedEntries: number;
  cachedBytes: number;
  downloadedEntries: number;
  downloadedBytes: number;
  completedEntries: number;
  completedBytes: number;
  totalEntries: number;
  totalBytes: number;
};

export type OfflinePackageCancelAcknowledgement = {
  type: "PWA_OFFLINE_CANCEL_ACK";
  protocol: typeof PWA_OFFLINE_PROTOCOL_VERSION;
  requestId: string;
  buildVersion: string;
  accepted: boolean;
};

export type OfflinePackageErrorResponse = {
  type: "PWA_OFFLINE_ERROR";
  protocol: typeof PWA_OFFLINE_PROTOCOL_VERSION;
  requestId: string;
  buildVersion: string;
  code: OfflinePackageErrorCode;
  retryable: boolean;
};

export type OfflinePackageDownloadResult = OfflinePackageStatus & {
  type: "PWA_OFFLINE_COMPLETE" | "PWA_OFFLINE_CANCELLED";
};

type OfflinePackageRequestType =
  | "PWA_OFFLINE_STATUS"
  | "PWA_OFFLINE_PACKAGE_START"
  | "PWA_OFFLINE_PACKAGE_CANCEL"
  | "PWA_OFFLINE_PACKAGE_REMOVE";

type OfflinePackageRequest = {
  type: OfflinePackageRequestType;
  protocol: typeof PWA_OFFLINE_PROTOCOL_VERSION;
  requestId: string;
};

export type OfflinePackageMessageTarget = Pick<ServiceWorker, "postMessage">;

export class OfflinePackageClientError extends Error {
  readonly code:
    | OfflinePackageErrorCode
    | "invalid-response"
    | "timeout"
    | "unavailable"
    | "disconnected";
  readonly retryable: boolean;

  constructor(
    code: OfflinePackageClientError["code"],
    message: string,
    options: { retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "OfflinePackageClientError";
    this.code = code;
    this.retryable = options.retryable ?? false;
  }
}

export type OfflinePackageDownload = {
  requestId: string;
  result: Promise<OfflinePackageDownloadResult>;
  cancel: () => Promise<OfflinePackageCancelAcknowledgement>;
  disconnect: () => void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean {
  const keys = Object.keys(value).toSorted();
  const expected = [...expectedKeys].toSorted();
  return (
    keys.length === expected.length &&
    keys.every((key, index) => key === expected[index])
  );
}

function isSafeCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function hasValidEnvelope(
  value: Record<string, unknown>,
  requestId: string,
): boolean {
  return (
    value.protocol === PWA_OFFLINE_PROTOCOL_VERSION &&
    value.requestId === requestId &&
    typeof value.buildVersion === "string" &&
    value.buildVersion.length > 0 &&
    value.buildVersion.length <= 128
  );
}

const statusKeys = [
  "type",
  "protocol",
  "requestId",
  "buildVersion",
  "state",
  "cachedEntries",
  "cachedBytes",
  "missingEntries",
  "missingBytes",
  "totalEntries",
  "totalBytes",
] as const;

const statusTypes = new Set<OfflinePackageStatus["type"]>([
  "PWA_OFFLINE_STATUS",
  "PWA_OFFLINE_COMPLETE",
  "PWA_OFFLINE_CANCELLED",
  "PWA_OFFLINE_REMOVED",
]);

export function parseOfflinePackageStatus(
  value: unknown,
  requestId: string,
): OfflinePackageStatus | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, statusKeys) ||
    !hasValidEnvelope(value, requestId) ||
    typeof value.type !== "string" ||
    !statusTypes.has(value.type as OfflinePackageStatus["type"]) ||
    !["shell", "partial", "complete"].includes(String(value.state))
  ) {
    return null;
  }

  const counts = [
    value.cachedEntries,
    value.cachedBytes,
    value.missingEntries,
    value.missingBytes,
    value.totalEntries,
    value.totalBytes,
  ];
  if (!counts.every(isSafeCount)) return null;

  const cachedEntries = Number(value.cachedEntries);
  const cachedBytes = Number(value.cachedBytes);
  const missingEntries = Number(value.missingEntries);
  const missingBytes = Number(value.missingBytes);
  const totalEntries = Number(value.totalEntries);
  const totalBytes = Number(value.totalBytes);
  const isComplete = missingEntries === 0 && missingBytes === 0;
  if (
    cachedEntries + missingEntries !== totalEntries ||
    cachedBytes + missingBytes !== totalBytes ||
    (value.state === "complete") !== isComplete ||
    (value.type === "PWA_OFFLINE_COMPLETE" && value.state !== "complete") ||
    (value.type === "PWA_OFFLINE_CANCELLED" && value.state === "complete")
  ) {
    return null;
  }

  return value as OfflinePackageStatus;
}

const progressKeys = [
  "type",
  "protocol",
  "requestId",
  "buildVersion",
  "phase",
  "processedEntries",
  "cachedEntries",
  "cachedBytes",
  "downloadedEntries",
  "downloadedBytes",
  "completedEntries",
  "completedBytes",
  "totalEntries",
  "totalBytes",
] as const;

export function parseOfflinePackageProgress(
  value: unknown,
  requestId: string,
): OfflinePackageProgress | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, progressKeys) ||
    !hasValidEnvelope(value, requestId) ||
    value.type !== "PWA_OFFLINE_PROGRESS" ||
    (value.phase !== "checking" && value.phase !== "downloading")
  ) {
    return null;
  }

  const entryCounts = [
    value.processedEntries,
    value.cachedEntries,
    value.downloadedEntries,
    value.completedEntries,
    value.totalEntries,
  ];
  const byteCounts = [
    value.cachedBytes,
    value.downloadedBytes,
    value.completedBytes,
    value.totalBytes,
  ];
  if (![...entryCounts, ...byteCounts].every(isSafeCount)) return null;

  const totalEntries = Number(value.totalEntries);
  const totalBytes = Number(value.totalBytes);
  const cachedEntries = Number(value.cachedEntries);
  const cachedBytes = Number(value.cachedBytes);
  const downloadedEntries = Number(value.downloadedEntries);
  const downloadedBytes = Number(value.downloadedBytes);
  const completedEntries = Number(value.completedEntries);
  const completedBytes = Number(value.completedBytes);
  if (
    entryCounts.slice(0, -1).some((count) => Number(count) > totalEntries) ||
    byteCounts.slice(0, -1).some((count) => Number(count) > totalBytes) ||
    completedEntries !== cachedEntries + downloadedEntries ||
    completedBytes !== cachedBytes + downloadedBytes ||
    (value.phase === "checking" &&
      (downloadedEntries !== 0 || downloadedBytes !== 0))
  ) {
    return null;
  }

  return value as OfflinePackageProgress;
}

const errorKeys = [
  "type",
  "protocol",
  "requestId",
  "buildVersion",
  "code",
  "retryable",
] as const;

export function parseOfflinePackageError(
  value: unknown,
  requestId: string,
): OfflinePackageErrorResponse | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, errorKeys) ||
    !hasValidEnvelope(value, requestId) ||
    value.type !== "PWA_OFFLINE_ERROR" ||
    typeof value.code !== "string" ||
    !offlinePackageErrorCodes.includes(value.code as OfflinePackageErrorCode) ||
    typeof value.retryable !== "boolean"
  ) {
    return null;
  }
  return value as OfflinePackageErrorResponse;
}

const cancelAcknowledgementKeys = [
  "type",
  "protocol",
  "requestId",
  "buildVersion",
  "accepted",
] as const;

export function parseOfflinePackageCancelAcknowledgement(
  value: unknown,
  requestId: string,
): OfflinePackageCancelAcknowledgement | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, cancelAcknowledgementKeys) ||
    !hasValidEnvelope(value, requestId) ||
    value.type !== "PWA_OFFLINE_CANCEL_ACK" ||
    typeof value.accepted !== "boolean"
  ) {
    return null;
  }
  return value as OfflinePackageCancelAcknowledgement;
}

function createRequestId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `pwa_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

function requestFor(
  type: OfflinePackageRequestType,
  requestId = createRequestId(),
): OfflinePackageRequest {
  if (!requestIdPattern.test(requestId)) {
    throw new OfflinePackageClientError(
      "unavailable",
      "无法生成有效的离线包请求标识。",
    );
  }
  return { type, protocol: PWA_OFFLINE_PROTOCOL_VERSION, requestId };
}

function errorFromResponse(
  response: OfflinePackageErrorResponse,
): OfflinePackageClientError {
  return new OfflinePackageClientError(
    response.code,
    `离线包请求失败：${response.code}`,
    { retryable: response.retryable },
  );
}

function invalidResponseError(): OfflinePackageClientError {
  return new OfflinePackageClientError(
    "invalid-response",
    "Service Worker 返回了无法验证的离线包响应。",
    { retryable: true },
  );
}

function isMonotonicProgress(
  previous: OfflinePackageProgress | null,
  current: OfflinePackageProgress,
): boolean {
  if (!previous) return true;
  if (
    current.buildVersion !== previous.buildVersion ||
    current.totalEntries !== previous.totalEntries ||
    current.totalBytes !== previous.totalBytes ||
    (previous.phase === "downloading" && current.phase === "checking")
  ) {
    return false;
  }

  const monotonicFields = [
    "cachedEntries",
    "cachedBytes",
    "downloadedEntries",
    "downloadedBytes",
    "completedEntries",
    "completedBytes",
  ] as const;
  if (!monotonicFields.every((field) => current[field] >= previous[field])) {
    return false;
  }

  const entersDownloadPhase =
    previous.phase === "checking" && current.phase === "downloading";
  return (
    entersDownloadPhase || current.processedEntries >= previous.processedEntries
  );
}

export class OfflinePackageClient {
  readonly #target: OfflinePackageMessageTarget;
  readonly #responseTimeoutMs: number;
  readonly #downloadInactivityTimeoutMs: number;

  constructor(
    target: OfflinePackageMessageTarget,
    options: {
      responseTimeoutMs?: number;
      downloadInactivityTimeoutMs?: number;
    } = {},
  ) {
    const responseTimeoutMs =
      options.responseTimeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS;
    const downloadInactivityTimeoutMs =
      options.downloadInactivityTimeoutMs ??
      DEFAULT_DOWNLOAD_INACTIVITY_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(responseTimeoutMs) ||
      responseTimeoutMs <= 0 ||
      !Number.isSafeInteger(downloadInactivityTimeoutMs) ||
      downloadInactivityTimeoutMs <= 0
    ) {
      throw new RangeError(
        "Offline package timeouts must be positive integers.",
      );
    }
    this.#target = target;
    this.#responseTimeoutMs = responseTimeoutMs;
    this.#downloadInactivityTimeoutMs = downloadInactivityTimeoutMs;
  }

  status(): Promise<OfflinePackageStatus> {
    return this.#requestOnce("PWA_OFFLINE_STATUS", (value, requestId) => {
      const error = parseOfflinePackageError(value, requestId);
      if (error) throw errorFromResponse(error);
      const status = parseOfflinePackageStatus(value, requestId);
      return status?.type === "PWA_OFFLINE_STATUS" ? status : null;
    });
  }

  remove(): Promise<OfflinePackageStatus> {
    return this.#requestOnce(
      "PWA_OFFLINE_PACKAGE_REMOVE",
      (value, requestId) => {
        const error = parseOfflinePackageError(value, requestId);
        if (error) throw errorFromResponse(error);
        const status = parseOfflinePackageStatus(value, requestId);
        return status?.type === "PWA_OFFLINE_REMOVED" ? status : null;
      },
    );
  }

  start(
    onProgress?: (progress: OfflinePackageProgress) => void,
  ): OfflinePackageDownload {
    const request = requestFor("PWA_OFFLINE_PACKAGE_START");
    const channel = new MessageChannel();
    let settled = false;
    let previousProgress: OfflinePackageProgress | null = null;
    let inactivityTimeout: ReturnType<typeof setTimeout> | undefined;
    let rejectResult: (reason: OfflinePackageClientError) => void = () =>
      undefined;

    const close = () => {
      if (inactivityTimeout !== undefined) {
        globalThis.clearTimeout(inactivityTimeout);
      }
      channel.port1.onmessage = null;
      channel.port1.onmessageerror = null;
      channel.port1.close();
    };

    const result = new Promise<OfflinePackageDownloadResult>(
      (resolve, reject) => {
        rejectResult = reject;
        const rejectAndClose = (error: OfflinePackageClientError) => {
          if (settled) return;
          settled = true;
          close();
          reject(error);
        };
        const armInactivityTimeout = () => {
          if (inactivityTimeout !== undefined) {
            globalThis.clearTimeout(inactivityTimeout);
          }
          inactivityTimeout = globalThis.setTimeout(() => {
            void this.#cancel(request.requestId).catch(() => undefined);
            rejectAndClose(
              new OfflinePackageClientError(
                "timeout",
                "等待 Service Worker 下载进度超时。",
                { retryable: true },
              ),
            );
          }, this.#downloadInactivityTimeoutMs);
        };

        channel.port1.onmessage = (event: MessageEvent<unknown>) => {
          try {
            const progress = parseOfflinePackageProgress(
              event.data,
              request.requestId,
            );
            if (progress) {
              if (!isMonotonicProgress(previousProgress, progress)) {
                rejectAndClose(invalidResponseError());
                return;
              }
              previousProgress = progress;
              armInactivityTimeout();
              onProgress?.(progress);
              return;
            }

            const error = parseOfflinePackageError(
              event.data,
              request.requestId,
            );
            if (error) {
              rejectAndClose(errorFromResponse(error));
              return;
            }

            const status = parseOfflinePackageStatus(
              event.data,
              request.requestId,
            );
            if (
              status?.type !== "PWA_OFFLINE_COMPLETE" &&
              status?.type !== "PWA_OFFLINE_CANCELLED"
            ) {
              rejectAndClose(invalidResponseError());
              return;
            }

            if (settled) return;
            settled = true;
            close();
            resolve(status as OfflinePackageDownloadResult);
          } catch (error) {
            rejectAndClose(
              error instanceof OfflinePackageClientError
                ? error
                : new OfflinePackageClientError(
                    "invalid-response",
                    "无法处理离线包响应。",
                    { retryable: true, cause: error },
                  ),
            );
          }
        };
        channel.port1.onmessageerror = () =>
          rejectAndClose(invalidResponseError());
        channel.port1.start();
        armInactivityTimeout();

        try {
          this.#target.postMessage(request, [channel.port2]);
        } catch (error) {
          rejectAndClose(
            new OfflinePackageClientError(
              "unavailable",
              "无法向 Service Worker 发送离线包请求。",
              { retryable: true, cause: error },
            ),
          );
        }
      },
    );

    return {
      requestId: request.requestId,
      result,
      cancel: () => this.#cancel(request.requestId),
      disconnect: () => {
        if (settled) return;
        settled = true;
        close();
        rejectResult(
          new OfflinePackageClientError(
            "disconnected",
            "页面已停止监听离线包进度；下载不会因此自动取消。",
          ),
        );
      },
    };
  }

  #cancel(requestId: string): Promise<OfflinePackageCancelAcknowledgement> {
    return this.#requestOnce(
      "PWA_OFFLINE_PACKAGE_CANCEL",
      (value, expectedRequestId) => {
        const error = parseOfflinePackageError(value, expectedRequestId);
        if (error) throw errorFromResponse(error);
        return parseOfflinePackageCancelAcknowledgement(
          value,
          expectedRequestId,
        );
      },
      requestId,
    );
  }

  #requestOnce<T>(
    type: Exclude<OfflinePackageRequestType, "PWA_OFFLINE_PACKAGE_START">,
    parse: (value: unknown, requestId: string) => T | null,
    requestId?: string,
  ): Promise<T> {
    const request = requestFor(type, requestId);

    return new Promise<T>((resolve, reject) => {
      const channel = new MessageChannel();
      let settled = false;
      const close = () => {
        globalThis.clearTimeout(timeout);
        channel.port1.onmessage = null;
        channel.port1.onmessageerror = null;
        channel.port1.close();
      };
      const rejectAndClose = (error: OfflinePackageClientError) => {
        if (settled) return;
        settled = true;
        close();
        reject(error);
      };
      const timeout = globalThis.setTimeout(
        () =>
          rejectAndClose(
            new OfflinePackageClientError(
              "timeout",
              "等待 Service Worker 响应超时。",
              { retryable: true },
            ),
          ),
        this.#responseTimeoutMs,
      );

      channel.port1.onmessage = (event: MessageEvent<unknown>) => {
        try {
          const parsed = parse(event.data, request.requestId);
          if (!parsed) {
            rejectAndClose(invalidResponseError());
            return;
          }
          if (settled) return;
          settled = true;
          close();
          resolve(parsed);
        } catch (error) {
          rejectAndClose(
            error instanceof OfflinePackageClientError
              ? error
              : new OfflinePackageClientError(
                  "invalid-response",
                  "无法处理 Service Worker 响应。",
                  { retryable: true, cause: error },
                ),
          );
        }
      };
      channel.port1.onmessageerror = () =>
        rejectAndClose(invalidResponseError());
      channel.port1.start();

      try {
        this.#target.postMessage(request, [channel.port2]);
      } catch (error) {
        rejectAndClose(
          new OfflinePackageClientError(
            "unavailable",
            "无法向 Service Worker 发送离线包请求。",
            { retryable: true, cause: error },
          ),
        );
      }
    });
  }
}

export function isOfflinePackageClientError(
  value: unknown,
): value is OfflinePackageClientError {
  return value instanceof OfflinePackageClientError;
}

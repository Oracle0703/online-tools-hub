import { afterEach, describe, expect, it, vi } from "vitest";

import {
  isOfflinePackageClientError,
  OfflinePackageClient,
  OfflinePackageClientError,
  type OfflinePackageMessageTarget,
  parseOfflinePackageCancelAcknowledgement,
  parseOfflinePackageError,
  parseOfflinePackageProgress,
  parseOfflinePackageStatus,
  PWA_OFFLINE_PROTOCOL_VERSION,
} from "./pwa-offline-package";

type RequestMessage = {
  type: string;
  protocol: number;
  requestId: string;
};

type TargetHandler = (request: RequestMessage, port: MessagePort) => void;

class FakeMessageTarget {
  readonly requests: RequestMessage[] = [];
  handler: TargetHandler;

  constructor(handler: TargetHandler = () => undefined) {
    this.handler = handler;
  }

  postMessage(message: unknown, transfer: Transferable[]): void {
    const request = message as RequestMessage;
    const port = transfer[0];
    if (!(port instanceof MessagePort)) throw new TypeError("missing port");
    this.requests.push(request);
    this.handler(request, port);
  }
}

function clientFor(
  target: FakeMessageTarget,
  responseTimeoutMs = 1_000,
  downloadInactivityTimeoutMs = 1_000,
): OfflinePackageClient {
  return new OfflinePackageClient(
    target as unknown as OfflinePackageMessageTarget,
    { responseTimeoutMs, downloadInactivityTimeoutMs },
  );
}

function statusMessage(
  requestId: string,
  type = "PWA_OFFLINE_STATUS",
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const complete = type === "PWA_OFFLINE_COMPLETE";
  return {
    type,
    protocol: PWA_OFFLINE_PROTOCOL_VERSION,
    requestId,
    buildVersion: "0123456789abcdef",
    state: complete ? "complete" : "partial",
    cachedEntries: complete ? 5 : 2,
    cachedBytes: complete ? 500 : 200,
    missingEntries: complete ? 0 : 3,
    missingBytes: complete ? 0 : 300,
    totalEntries: 5,
    totalBytes: 500,
    ...overrides,
  };
}

function progressMessage(
  requestId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: "PWA_OFFLINE_PROGRESS",
    protocol: PWA_OFFLINE_PROTOCOL_VERSION,
    requestId,
    buildVersion: "0123456789abcdef",
    phase: "downloading",
    processedEntries: 2,
    cachedEntries: 1,
    cachedBytes: 100,
    downloadedEntries: 1,
    downloadedBytes: 100,
    completedEntries: 2,
    completedBytes: 200,
    totalEntries: 5,
    totalBytes: 500,
    ...overrides,
  };
}

function errorMessage(
  requestId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: "PWA_OFFLINE_ERROR",
    protocol: PWA_OFFLINE_PROTOCOL_VERSION,
    requestId,
    buildVersion: "0123456789abcdef",
    code: "network",
    retryable: true,
    ...overrides,
  };
}

function cancelAcknowledgement(
  requestId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: "PWA_OFFLINE_CANCEL_ACK",
    protocol: PWA_OFFLINE_PROTOCOL_VERSION,
    requestId,
    buildVersion: "0123456789abcdef",
    accepted: true,
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("offline package response validation", () => {
  it.each([
    "PWA_OFFLINE_STATUS",
    "PWA_OFFLINE_COMPLETE",
    "PWA_OFFLINE_CANCELLED",
    "PWA_OFFLINE_REMOVED",
  ])("accepts the exact %s status envelope", (type) => {
    const value = statusMessage("request_1", type);
    expect(parseOfflinePackageStatus(value, "request_1")).toEqual(value);
  });

  it("rejects status responses with field, envelope, state or count drift", () => {
    const base = statusMessage("request_1");
    expect(
      parseOfflinePackageStatus({ ...base, extra: true }, "request_1"),
    ).toBeNull();
    expect(
      parseOfflinePackageStatus(
        { ...base, protocol: PWA_OFFLINE_PROTOCOL_VERSION + 1 },
        "request_1",
      ),
    ).toBeNull();
    expect(parseOfflinePackageStatus(base, "another_request")).toBeNull();
    expect(
      parseOfflinePackageStatus({ ...base, buildVersion: "" }, "request_1"),
    ).toBeNull();
    expect(
      parseOfflinePackageStatus(
        { ...base, buildVersion: "x".repeat(129) },
        "request_1",
      ),
    ).toBeNull();
    expect(
      parseOfflinePackageStatus({ ...base, type: "OTHER" }, "request_1"),
    ).toBeNull();
    expect(
      parseOfflinePackageStatus({ ...base, state: "ready" }, "request_1"),
    ).toBeNull();
    expect(
      parseOfflinePackageStatus({ ...base, cachedEntries: -1 }, "request_1"),
    ).toBeNull();
    expect(
      parseOfflinePackageStatus({ ...base, cachedEntries: 1.5 }, "request_1"),
    ).toBeNull();
    expect(
      parseOfflinePackageStatus({ ...base, cachedEntries: 6 }, "request_1"),
    ).toBeNull();
    expect(
      parseOfflinePackageStatus({ ...base, missingEntries: 6 }, "request_1"),
    ).toBeNull();
    expect(
      parseOfflinePackageStatus({ ...base, cachedBytes: 501 }, "request_1"),
    ).toBeNull();
    expect(
      parseOfflinePackageStatus({ ...base, missingBytes: 501 }, "request_1"),
    ).toBeNull();
    expect(
      parseOfflinePackageStatus({ ...base, missingEntries: 2 }, "request_1"),
    ).toBeNull();
    expect(
      parseOfflinePackageStatus({ ...base, missingBytes: 200 }, "request_1"),
    ).toBeNull();
    expect(
      parseOfflinePackageStatus(
        statusMessage("request_1", "PWA_OFFLINE_COMPLETE", {
          state: "partial",
          cachedEntries: 2,
          cachedBytes: 200,
          missingEntries: 3,
          missingBytes: 300,
        }),
        "request_1",
      ),
    ).toBeNull();
    expect(
      parseOfflinePackageStatus(
        statusMessage("request_1", "PWA_OFFLINE_CANCELLED", {
          state: "complete",
          cachedEntries: 5,
          cachedBytes: 500,
          missingEntries: 0,
          missingBytes: 0,
        }),
        "request_1",
      ),
    ).toBeNull();
    expect(
      parseOfflinePackageStatus(
        statusMessage("request_1", "PWA_OFFLINE_STATUS", {
          state: "complete",
        }),
        "request_1",
      ),
    ).toBeNull();
    expect(
      parseOfflinePackageStatus(
        statusMessage("request_1", "PWA_OFFLINE_COMPLETE", {
          state: "partial",
        }),
        "request_1",
      ),
    ).toBeNull();
    expect(parseOfflinePackageStatus(null, "request_1")).toBeNull();
    expect(parseOfflinePackageStatus([], "request_1")).toBeNull();
  });

  it("validates exact progress fields and numeric bounds", () => {
    const value = progressMessage("request_2");
    expect(parseOfflinePackageProgress(value, "request_2")).toEqual(value);
    expect(
      parseOfflinePackageProgress(
        progressMessage("request_2", {
          phase: "checking",
          downloadedEntries: 0,
          downloadedBytes: 0,
          completedEntries: 1,
          completedBytes: 100,
        }),
        "request_2",
      )?.phase,
    ).toBe("checking");
    expect(
      parseOfflinePackageProgress({ ...value, extra: 1 }, "request_2"),
    ).toBeNull();
    expect(
      parseOfflinePackageProgress({ ...value, phase: "writing" }, "request_2"),
    ).toBeNull();
    expect(
      parseOfflinePackageProgress(
        { ...value, completedEntries: 6 },
        "request_2",
      ),
    ).toBeNull();
    expect(
      parseOfflinePackageProgress(
        { ...value, completedBytes: 501 },
        "request_2",
      ),
    ).toBeNull();
    expect(
      parseOfflinePackageProgress(
        { ...value, processedEntries: Number.NaN },
        "request_2",
      ),
    ).toBeNull();
    expect(
      parseOfflinePackageProgress(
        { ...value, completedEntries: 1 },
        "request_2",
      ),
    ).toBeNull();
    expect(
      parseOfflinePackageProgress(
        { ...value, completedBytes: 100 },
        "request_2",
      ),
    ).toBeNull();
    expect(
      parseOfflinePackageProgress({ ...value, phase: "checking" }, "request_2"),
    ).toBeNull();
    expect(parseOfflinePackageProgress(value, "wrong")).toBeNull();
  });

  it("validates errors and cancel acknowledgements without loose fields", () => {
    const error = errorMessage("request_3");
    const acknowledgement = cancelAcknowledgement("request_3");
    expect(parseOfflinePackageError(error, "request_3")).toEqual(error);
    expect(
      parseOfflinePackageCancelAcknowledgement(acknowledgement, "request_3"),
    ).toEqual(acknowledgement);
    expect(
      parseOfflinePackageError({ ...error, code: "unknown" }, "request_3"),
    ).toBeNull();
    expect(
      parseOfflinePackageError({ ...error, retryable: "yes" }, "request_3"),
    ).toBeNull();
    expect(
      parseOfflinePackageError({ ...error, extra: true }, "request_3"),
    ).toBeNull();
    expect(
      parseOfflinePackageCancelAcknowledgement(
        { ...acknowledgement, accepted: 1 },
        "request_3",
      ),
    ).toBeNull();
    expect(
      parseOfflinePackageCancelAcknowledgement(
        { ...acknowledgement, type: "PWA_OFFLINE_STATUS" },
        "request_3",
      ),
    ).toBeNull();
  });
});

describe("OfflinePackageClient", () => {
  it("sends an exact status request and accepts its one-shot response", async () => {
    const target = new FakeMessageTarget((request, port) => {
      port.postMessage(statusMessage(request.requestId));
    });
    const status = await clientFor(target).status();

    expect(target.requests).toHaveLength(1);
    expect(target.requests[0]).toEqual({
      type: "PWA_OFFLINE_STATUS",
      protocol: PWA_OFFLINE_PROTOCOL_VERSION,
      requestId: expect.stringMatching(/^[A-Za-z0-9_-]{1,128}$/u),
    });
    expect(status.state).toBe("partial");
  });

  it("removes the content package through a separate request channel", async () => {
    const target = new FakeMessageTarget((request, port) => {
      port.postMessage(
        statusMessage(request.requestId, "PWA_OFFLINE_REMOVED", {
          state: "shell",
          cachedEntries: 0,
          cachedBytes: 0,
          missingEntries: 5,
          missingBytes: 500,
        }),
      );
    });

    const status = await clientFor(target).remove();
    expect(target.requests[0]?.type).toBe("PWA_OFFLINE_PACKAGE_REMOVE");
    expect(status.type).toBe("PWA_OFFLINE_REMOVED");
    expect(status.state).toBe("shell");
  });

  it("allows processedEntries to reset only when checking enters downloading", async () => {
    const progress = vi.fn();
    const target = new FakeMessageTarget((request, port) => {
      port.postMessage(
        progressMessage(request.requestId, {
          phase: "checking",
          processedEntries: 5,
          cachedEntries: 1,
          cachedBytes: 100,
          downloadedEntries: 0,
          downloadedBytes: 0,
          completedEntries: 1,
          completedBytes: 100,
        }),
      );
      port.postMessage(
        progressMessage(request.requestId, {
          processedEntries: 2,
          cachedEntries: 1,
          cachedBytes: 100,
          downloadedEntries: 1,
          downloadedBytes: 100,
          completedEntries: 2,
          completedBytes: 200,
        }),
      );
      port.postMessage(
        progressMessage(request.requestId, {
          processedEntries: 5,
          cachedEntries: 1,
          cachedBytes: 100,
          downloadedEntries: 4,
          downloadedBytes: 400,
          completedEntries: 5,
          completedBytes: 500,
        }),
      );
      port.postMessage(
        statusMessage(request.requestId, "PWA_OFFLINE_COMPLETE", {
          state: "complete",
          cachedEntries: 5,
          cachedBytes: 500,
          missingEntries: 0,
          missingBytes: 0,
        }),
      );
    });

    const download = clientFor(target).start(progress);
    const result = await download.result;
    expect(target.requests[0]?.type).toBe("PWA_OFFLINE_PACKAGE_START");
    expect(progress).toHaveBeenCalledTimes(3);
    expect(result.type).toBe("PWA_OFFLINE_COMPLETE");
    expect(result.state).toBe("complete");
  });

  it.each([
    { processedEntries: 0 },
    { completedBytes: 50 },
    { totalEntries: 6 },
    { totalBytes: 600 },
    { buildVersion: "changed" },
    { phase: "checking" },
  ])("rejects non-monotonic streamed progress %#", async (regression) => {
    const target = new FakeMessageTarget((request, port) => {
      port.postMessage(progressMessage(request.requestId));
      port.postMessage(progressMessage(request.requestId, regression));
    });

    const error = await clientFor(target)
      .start()
      .result.catch((value) => value);
    expect(error).toBeInstanceOf(OfflinePackageClientError);
    expect(error).toMatchObject({ code: "invalid-response", retryable: true });
  });

  it("uses the start request id for cancellation and receives both terminals", async () => {
    let startPort: MessagePort | null = null;
    const target = new FakeMessageTarget((request, port) => {
      if (request.type === "PWA_OFFLINE_PACKAGE_START") {
        startPort = port;
        port.postMessage(progressMessage(request.requestId));
        return;
      }
      expect(request.type).toBe("PWA_OFFLINE_PACKAGE_CANCEL");
      port.postMessage(cancelAcknowledgement(request.requestId));
      startPort?.postMessage(
        statusMessage(request.requestId, "PWA_OFFLINE_CANCELLED", {
          state: "shell",
          cachedEntries: 0,
          cachedBytes: 0,
          missingEntries: 5,
          missingBytes: 500,
        }),
      );
    });

    const download = clientFor(target).start();
    const acknowledgement = await download.cancel();
    const result = await download.result;

    expect(acknowledgement.accepted).toBe(true);
    expect(target.requests[1]?.requestId).toBe(download.requestId);
    expect(result.type).toBe("PWA_OFFLINE_CANCELLED");
  });

  it("turns stable worker errors into safe client errors", async () => {
    const target = new FakeMessageTarget((request, port) => {
      port.postMessage(
        errorMessage(request.requestId, { code: "quota", retryable: false }),
      );
    });

    const errors = await Promise.all([
      clientFor(target)
        .status()
        .catch((error: unknown) => error),
      clientFor(target)
        .remove()
        .catch((error: unknown) => error),
      clientFor(target)
        .start()
        .result.catch((error: unknown) => error),
    ]);
    for (const error of errors) {
      expect(isOfflinePackageClientError(error)).toBe(true);
      expect(error).toMatchObject({ code: "quota", retryable: false });
    }
  });

  it("rejects an unexpected valid response type", async () => {
    const target = new FakeMessageTarget((request, port) => {
      port.postMessage(
        statusMessage(request.requestId, "PWA_OFFLINE_COMPLETE"),
      );
    });
    const error = await clientFor(target)
      .status()
      .catch((value) => value);
    expect(error).toMatchObject({ code: "invalid-response" });
  });

  it("times out a one-shot request without a response", async () => {
    vi.useFakeTimers();
    const target = new FakeMessageTarget();
    const statusPromise = clientFor(target, 25)
      .status()
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(25);
    await expect(statusPromise).resolves.toMatchObject({
      code: "timeout",
      retryable: true,
    });
  });

  it("times out a download whose progress channel becomes inactive", async () => {
    vi.useFakeTimers();
    const target = new FakeMessageTarget((request, port) => {
      if (request.type === "PWA_OFFLINE_PACKAGE_CANCEL") {
        port.postMessage(cancelAcknowledgement(request.requestId));
      }
    });
    const result = clientFor(target, 1_000, 25)
      .start()
      .result.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(25);
    await expect(result).resolves.toMatchObject({
      code: "timeout",
      retryable: true,
    });
    expect(target.requests.map((request) => request.type)).toEqual([
      "PWA_OFFLINE_PACKAGE_START",
      "PWA_OFFLINE_PACKAGE_CANCEL",
    ]);
    expect(target.requests[1]?.requestId).toBe(target.requests[0]?.requestId);
  });

  it("rejects invalid response and download timeout configuration", () => {
    const target = new FakeMessageTarget();
    expect(() => clientFor(target, 0)).toThrow(RangeError);
    expect(() => clientFor(target, 1_000, -1)).toThrow(RangeError);
  });

  it("reports synchronous postMessage failures", async () => {
    const target = new FakeMessageTarget();
    target.postMessage = () => {
      throw new Error("postMessage unavailable");
    };
    const client = clientFor(target);
    await expect(client.status()).rejects.toMatchObject({
      code: "unavailable",
      retryable: true,
    });
    await expect(client.start().result).rejects.toMatchObject({
      code: "unavailable",
      retryable: true,
    });
  });

  it("disconnects the page listener without sending a cancellation", async () => {
    const target = new FakeMessageTarget();
    const download = clientFor(target).start();
    download.disconnect();
    download.disconnect();

    await expect(download.result).rejects.toMatchObject({
      code: "disconnected",
      retryable: false,
    });
    expect(target.requests).toHaveLength(1);
    expect(target.requests[0]?.type).toBe("PWA_OFFLINE_PACKAGE_START");
  });
});

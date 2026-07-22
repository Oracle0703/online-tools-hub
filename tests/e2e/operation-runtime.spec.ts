import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";

import type {
  OperationRuntimeProbe,
  OperationRuntimeProbeResult,
  OperationRuntimeProbeSnapshot,
  OperationRuntimeProbeStart,
} from "../../src/lib/operation-runtime-probe";
import type { OperationRequest } from "../../src/operations/contract";

type RuntimeProbeWindow = Window &
  typeof globalThis & {
    readonly __onlineToolsOperationProbe?: OperationRuntimeProbe;
    readonly __operationWorkerLifecycle?: {
      created: number;
      terminated: number;
      urls: string[];
    };
  };

async function openRuntimeProbe(page: Page): Promise<void> {
  await page.goto("./__runtime/operations/", { waitUntil: "networkidle" });
  await page.waitForFunction(
    () =>
      document.documentElement.dataset.operationRuntimeProbe === "ready" &&
      Boolean((window as RuntimeProbeWindow).__onlineToolsOperationProbe),
  );
}

async function startOperation(
  page: Page,
  request: OperationRequest,
): Promise<OperationRuntimeProbeStart> {
  return page.evaluate<OperationRuntimeProbeStart, unknown>((candidate) => {
    const probe = (window as RuntimeProbeWindow).__onlineToolsOperationProbe;
    if (probe === undefined) throw new Error("Operation probe is not ready.");
    return probe.start(candidate as OperationRequest);
  }, request as unknown);
}

async function waitForOperation(
  page: Page,
  taskId: string,
): Promise<OperationRuntimeProbeResult> {
  return page.evaluate(async (candidateTaskId) => {
    const probe = (window as RuntimeProbeWindow).__onlineToolsOperationProbe;
    if (probe === undefined) throw new Error("Operation probe is not ready.");
    return probe.wait(candidateTaskId);
  }, taskId);
}

async function runtimeSnapshot(
  page: Page,
): Promise<OperationRuntimeProbeSnapshot> {
  return page.evaluate(() => {
    const probe = (window as RuntimeProbeWindow).__onlineToolsOperationProbe;
    if (probe === undefined) throw new Error("Operation probe is not ready.");
    return probe.snapshot();
  });
}

test("生产构建通过真实 Worker 执行大 JSON Operation", async ({ page }) => {
  await openRuntimeProbe(page);

  const payload = "本地数据🙂".repeat(18_000);
  const source = JSON.stringify({ message: "真实 Worker", payload });
  const started = await startOperation(page, {
    operationId: "json.transform",
    input: { kind: "text", text: source },
    options: { mode: "format", indent: 2 },
  });

  expect(started.location).toBe("worker");
  const result = await waitForOperation(page, started.taskId);
  expect(result.ok).toBe(true);
  if (!result.ok || result.output.kind !== "text") {
    throw new Error("JSON Operation did not return text output.");
  }
  expect(JSON.parse(result.output.text)).toEqual({
    message: "真实 Worker",
    payload,
  });
  await expect
    .poll(() => runtimeSnapshot(page))
    .toMatchObject({
      activeTaskCount: 0,
      activeWorkerCount: 0,
      globalActiveTaskCount: 0,
      globalActiveWorkerCount: 0,
      pendingResultCount: 0,
    });
});

test("生产构建通过中央 Operation Worker 执行 regex.test JSON 信封", async ({
  page,
}) => {
  await openRuntimeProbe(page);

  const started = await startOperation(page, {
    operationId: "regex.test",
    input: {
      kind: "text",
      text: JSON.stringify({
        pattern: String.raw`(?<word>\p{L}+)(?:-(\d+))?`,
        flags: "gu",
        subject: "alpha-12 中文 beta",
      }),
    },
    options: {},
  });

  expect(started.location).toBe("worker");
  const result = await waitForOperation(page, started.taskId);
  expect(result.ok).toBe(true);
  if (!result.ok || result.output.kind !== "text") {
    throw new Error("Regex Operation did not return text output.");
  }
  expect(JSON.parse(result.output.text)).toMatchObject({
    ok: true,
    flags: "gu",
    truncated: false,
    matches: [
      {
        ordinal: 1,
        index: 0,
        end: 8,
        text: "alpha-12",
        captures: ["alpha", "12"],
        namedCaptures: [{ name: "word", value: "alpha" }],
      },
      {
        ordinal: 2,
        index: 9,
        end: 11,
        text: "中文",
        captures: ["中文", null],
        namedCaptures: [{ name: "word", value: "中文" }],
      },
      {
        ordinal: 3,
        index: 12,
        end: 16,
        text: "beta",
        captures: ["beta", null],
        namedCaptures: [{ name: "word", value: "beta" }],
      },
    ],
  });
  await expect
    .poll(() => runtimeSnapshot(page))
    .toMatchObject({
      activeTaskCount: 0,
      activeWorkerCount: 0,
      globalActiveTaskCount: 0,
      globalActiveWorkerCount: 0,
      pendingResultCount: 0,
    });
});

test("真实 Worker 往返 transfer RGBA 与 PNG 且不 detach 调用方数据", async ({
  page,
}) => {
  await openRuntimeProbe(page);

  const execution = await page.evaluate(async () => {
    const probe = (window as RuntimeProbeWindow).__onlineToolsOperationProbe;
    if (probe === undefined) throw new Error("Operation probe is not ready.");

    const callerPixels = Uint8ClampedArray.from([255, 0, 0, 255]);
    const started = probe.start({
      operationId: "image.rgba-to-png",
      input: {
        kind: "rgba-image",
        width: 1,
        height: 1,
        data: callerPixels,
      },
      options: { paletteColors: 2 },
    });
    const callerAfterStart = {
      byteLength: callerPixels.byteLength,
      values: [...callerPixels],
    };
    const result = await probe.wait(started.taskId);
    return { started, callerAfterStart, result };
  });

  expect(execution.started.location).toBe("worker");
  expect(execution.callerAfterStart).toEqual({
    byteLength: 4,
    values: [255, 0, 0, 255],
  });
  expect(execution.result).toMatchObject({
    ok: true,
    output: {
      kind: "binary",
      mimeType: "image/png",
    },
  });
  if (execution.result.ok && execution.result.output.kind === "binary") {
    expect(execution.result.output.byteLength).toBeGreaterThan(8);
  }
  await expect
    .poll(() => runtimeSnapshot(page))
    .toMatchObject({
      activeTaskCount: 0,
      activeWorkerCount: 0,
      globalActiveTaskCount: 0,
      globalActiveWorkerCount: 0,
      pendingResultCount: 0,
    });
});

test("取消真实 Worker 会同步终止 Worker 并释放资源", async ({ page }) => {
  await page.addInitScript(() => {
    const NativeWorker = globalThis.Worker;
    const lifecycle = { created: 0, terminated: 0, urls: [] as string[] };
    const nativeTerminate = NativeWorker.prototype.terminate;

    Object.defineProperty(NativeWorker.prototype, "terminate", {
      configurable: true,
      writable: true,
      value(this: Worker) {
        lifecycle.terminated += 1;
        return nativeTerminate.call(this);
      },
    });
    Object.defineProperty(globalThis, "Worker", {
      configurable: true,
      writable: true,
      value: new Proxy(NativeWorker, {
        construct(target, argumentsList) {
          lifecycle.created += 1;
          lifecycle.urls.push(String(argumentsList[0]));
          return Reflect.construct(target, argumentsList, target);
        },
      }),
    });
    Object.defineProperty(globalThis, "__operationWorkerLifecycle", {
      configurable: false,
      value: lifecycle,
    });
  });
  await openRuntimeProbe(page);

  const started = await startOperation(page, {
    operationId: "text.diff",
    input: {
      kind: "text-pair",
      left: "left local line\n".repeat(20_000),
      right: "right local line\n".repeat(20_000),
    },
    options: { ignoreWhitespace: false, ignoreCase: false },
  });
  expect(started.location).toBe("worker");

  const cancellation = await page.evaluate((taskId) => {
    const runtimeWindow = window as RuntimeProbeWindow;
    const probe = runtimeWindow.__onlineToolsOperationProbe;
    const lifecycle = runtimeWindow.__operationWorkerLifecycle;
    if (probe === undefined || lifecycle === undefined) {
      throw new Error("Operation or Worker probe is not ready.");
    }
    const terminatedBefore = lifecycle.terminated;
    const cancelled = probe.cancel(taskId);
    return {
      cancelled,
      created: lifecycle.created,
      terminatedBefore,
      terminatedAfter: lifecycle.terminated,
      urls: [...lifecycle.urls],
    };
  }, started.taskId);

  expect(cancellation.cancelled).toBe(true);
  expect(cancellation.created).toBeGreaterThanOrEqual(1);
  expect(cancellation.terminatedAfter).toBe(cancellation.terminatedBefore + 1);
  expect(cancellation.urls).toEqual(
    expect.arrayContaining([
      expect.stringMatching(/operation\.worker[-.][A-Za-z0-9_-]+\.js/u),
    ]),
  );

  const result = await waitForOperation(page, started.taskId);
  expect(result).toMatchObject({
    ok: false,
    error: {
      name: "OperationError",
      code: "cancelled",
      operationId: "text.diff",
    },
  });
  await expect
    .poll(() => runtimeSnapshot(page))
    .toMatchObject({
      activeTaskCount: 0,
      activeWorkerCount: 0,
      globalActiveTaskCount: 0,
      globalActiveWorkerCount: 0,
      pendingResultCount: 0,
    });
});

test("Worker Operation 零外发、零持久化且错误不泄漏输入", async ({ page }) => {
  const runtimeRequests: Array<{
    url: string;
    method: string;
    resourceType: string;
    postData: string | null;
    headers: Record<string, string>;
  }> = [];
  const consoleEntries: string[] = [];
  let captureRuntime = false;

  page.on("request", (request) => {
    if (!captureRuntime) return;
    runtimeRequests.push({
      url: request.url(),
      method: request.method(),
      resourceType: request.resourceType(),
      postData: request.postData(),
      headers: request.headers(),
    });
  });
  page.on("console", (message) => {
    if (captureRuntime) consoleEntries.push(message.text());
  });

  await openRuntimeProbe(page);
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
    "content",
    "noindex, nofollow",
  );
  await expect(page.locator('link[rel="canonical"]')).toHaveCount(0);
  const storageBefore = await page.evaluate(() => ({
    local: Object.entries(localStorage),
    session: Object.entries(sessionStorage),
  }));

  const canary = `OTH_RUNTIME_CANARY_${Date.now()}_中文🙂`;
  const invalidSource = `{"padding":"${"x".repeat(140 * 1024)}","${canary}":not_json}`;
  captureRuntime = true;
  const started = await startOperation(page, {
    operationId: "json.transform",
    input: { kind: "text", text: invalidSource },
    options: { mode: "format", indent: 2 },
  });
  expect(started.location).toBe("worker");
  const result = await waitForOperation(page, started.taskId);
  captureRuntime = false;

  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Invalid JSON unexpectedly succeeded.");
  const serializedFailure = JSON.stringify(result.error);
  const canaryRepresentations = [
    canary,
    encodeURI(canary),
    encodeURIComponent(canary),
    Buffer.from(canary, "utf8").toString("base64"),
    Buffer.from(canary, "utf8")
      .toString("base64")
      .replace(/\+/gu, "-")
      .replace(/\//gu, "_")
      .replace(/=+$/u, ""),
    createHash("sha256").update(canary).digest("hex"),
  ];
  for (const representation of canaryRepresentations) {
    expect(serializedFailure).not.toContain(representation);
    expect(consoleEntries.join("\n")).not.toContain(representation);
  }

  const pageOrigin = new URL(page.url()).origin;
  for (const request of runtimeRequests) {
    const requestUrl = new URL(request.url);
    expect(requestUrl.origin).toBe(pageOrigin);
    expect(request.method).toBe("GET");
    expect(request.postData).toBeNull();
    if (
      ["fetch", "xhr", "websocket", "eventsource"].includes(
        request.resourceType,
      )
    ) {
      // WebKit reports a module Worker's same-origin bootstrap as `xhr` even
      // though no XMLHttpRequest is created. Keep the privacy assertion strict:
      // the only data-transport classification allowed is that immutable,
      // hashed Worker script; every other endpoint still fails this test.
      expect(requestUrl.pathname).toMatch(
        /\/operation\.worker[-.][A-Za-z0-9_-]+\.js$/u,
      );
      expect(requestUrl.search).toBe("");
      expect(requestUrl.hash).toBe("");
    }
    const serializedRequest = JSON.stringify(request);
    for (const representation of canaryRepresentations) {
      expect(serializedRequest).not.toContain(representation);
    }
  }
  expect(
    await page.evaluate(() => ({
      local: Object.entries(localStorage),
      session: Object.entries(sessionStorage),
    })),
  ).toEqual(storageBefore);
  await expect
    .poll(() => runtimeSnapshot(page))
    .toMatchObject({
      activeTaskCount: 0,
      activeWorkerCount: 0,
      globalActiveTaskCount: 0,
      globalActiveWorkerCount: 0,
      pendingResultCount: 0,
    });
});

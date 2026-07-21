import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";

import type {
  WorkflowRuntimeProbe,
  WorkflowRuntimeProbeResult,
  WorkflowRuntimeProbeSnapshot,
  WorkflowRuntimeProbeStart,
} from "../../src/lib/workflow-runtime-probe";
import type { WorkflowTemplateId } from "../../src/workflows/templates";

type RuntimeProbeWindow = Window &
  typeof globalThis & {
    readonly __onlineToolsWorkflowProbe?: WorkflowRuntimeProbe;
    readonly __workflowWorkerLifecycle?: {
      created: number;
      terminated: number;
      urls: string[];
    };
  };

type SerializableWorkflowInput =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "rgba-image";
      readonly width: number;
      readonly height: number;
      readonly data: readonly number[];
    };

const PNG_FIXTURE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAYAAAC09K7GAAAANUlEQVR4nBXIMREAMAgEwVdHHRF4SYMXbHxNg5zLZMuVxAktpWZ0kRIil8pm8ochvJSb8eUBpjAeBjxGdD0AAAAASUVORK5CYII=",
  "base64",
);

async function trackWorkers(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const NativeWorker = globalThis.Worker;
    const nativeTerminate = NativeWorker.prototype.terminate;
    const lifecycle = { created: 0, terminated: 0, urls: [] as string[] };

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
    Object.defineProperty(globalThis, "__workflowWorkerLifecycle", {
      configurable: false,
      value: lifecycle,
    });
  });
}

async function openRuntimeProbe(page: Page): Promise<void> {
  await page.goto("./__runtime/workflows/", { waitUntil: "networkidle" });
  await page.waitForFunction(
    () =>
      document.documentElement.dataset.workflowRuntimeProbe === "ready" &&
      Boolean((window as RuntimeProbeWindow).__onlineToolsWorkflowProbe),
  );
}

async function startWorkflow(
  page: Page,
  templateId: WorkflowTemplateId,
  input: SerializableWorkflowInput,
): Promise<WorkflowRuntimeProbeStart> {
  return page.evaluate(
    ({ candidateTemplateId, candidateInput }) => {
      const probe = (window as RuntimeProbeWindow).__onlineToolsWorkflowProbe;
      if (probe === undefined) throw new Error("Workflow probe is not ready.");
      const hydratedInput =
        candidateInput.kind === "rgba-image"
          ? {
              ...candidateInput,
              data: Uint8ClampedArray.from(candidateInput.data),
            }
          : candidateInput;
      return probe.start(candidateTemplateId, hydratedInput);
    },
    { candidateTemplateId: templateId, candidateInput: input },
  );
}

async function waitForWorkflow(
  page: Page,
  runId: string,
): Promise<WorkflowRuntimeProbeResult> {
  return page.evaluate(async (candidateRunId) => {
    const probe = (window as RuntimeProbeWindow).__onlineToolsWorkflowProbe;
    if (probe === undefined) throw new Error("Workflow probe is not ready.");
    return probe.wait(candidateRunId);
  }, runId);
}

async function runtimeSnapshot(
  page: Page,
): Promise<WorkflowRuntimeProbeSnapshot> {
  return page.evaluate(() => {
    const probe = (window as RuntimeProbeWindow).__onlineToolsWorkflowProbe;
    if (probe === undefined) throw new Error("Workflow probe is not ready.");
    return probe.snapshot();
  });
}

function textOutput(result: WorkflowRuntimeProbeResult): string {
  if (!result.ok || result.output.kind !== "text") {
    throw new Error("Workflow did not return text output.");
  }
  expect(result.output.truncated).toBe(false);
  return result.output.text;
}

async function expectReleased(page: Page): Promise<void> {
  await expect
    .poll(() => runtimeSnapshot(page))
    .toMatchObject({
      activeRunCount: 0,
      pendingResultCount: 0,
      vault: { entries: 0, bytes: 0, objectUrls: 0 },
      executor: {
        activeTaskCount: 0,
        activeWorkerCount: 0,
        activeMemoryBytes: 0,
        globalActiveTaskCount: 0,
        globalActiveWorkerCount: 0,
      },
    });
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

async function downloadFullOfflinePackage(page: Page): Promise<void> {
  const completion = await page.evaluate(async () => {
    const target = navigator.serviceWorker.controller;
    if (target === null) {
      throw new Error("Service Worker controller is unavailable.");
    }

    const random = crypto.getRandomValues(new Uint32Array(4));
    const requestId = `e2e_${Date.now().toString(36)}_${[...random]
      .map((value) => value.toString(36))
      .join("_")}`;
    const channel = new MessageChannel();

    return new Promise<{
      state: string;
      cachedEntries: number;
      totalEntries: number;
      cachedBytes: number;
      totalBytes: number;
    }>((resolve, reject) => {
      let settled = false;
      let timeout = 0;

      const close = () => {
        window.clearTimeout(timeout);
        channel.port1.onmessage = null;
        channel.port1.onmessageerror = null;
        channel.port1.close();
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        close();
        reject(error);
      };
      timeout = window.setTimeout(() => {
        fail(
          new Error("Timed out while downloading the full offline package."),
        );
      }, 90_000);

      channel.port1.onmessage = (event: MessageEvent<unknown>) => {
        const message = event.data;
        if (
          typeof message !== "object" ||
          message === null ||
          Array.isArray(message)
        ) {
          fail(new Error("Offline package returned an invalid response."));
          return;
        }

        const response = message as Record<string, unknown>;
        if (response.protocol !== 1 || response.requestId !== requestId) {
          fail(new Error("Offline package returned a mismatched response."));
          return;
        }
        if (response.type === "PWA_OFFLINE_PROGRESS") return;
        if (response.type === "PWA_OFFLINE_ERROR") {
          fail(
            new Error(
              `Offline package failed: ${String(response.code)} (retryable=${String(response.retryable)}).`,
            ),
          );
          return;
        }
        if (response.type === "PWA_OFFLINE_CANCELLED") {
          fail(new Error("Offline package was unexpectedly cancelled."));
          return;
        }
        if (response.type !== "PWA_OFFLINE_COMPLETE") {
          fail(
            new Error(
              `Offline package returned an unexpected message: ${String(response.type)}.`,
            ),
          );
          return;
        }

        const result = {
          state: String(response.state),
          cachedEntries: Number(response.cachedEntries),
          totalEntries: Number(response.totalEntries),
          cachedBytes: Number(response.cachedBytes),
          totalBytes: Number(response.totalBytes),
        };
        if (
          result.state !== "complete" ||
          !Number.isSafeInteger(result.cachedEntries) ||
          !Number.isSafeInteger(result.totalEntries) ||
          !Number.isSafeInteger(result.cachedBytes) ||
          !Number.isSafeInteger(result.totalBytes) ||
          result.cachedEntries !== result.totalEntries ||
          result.cachedBytes !== result.totalBytes
        ) {
          fail(new Error("Offline package completion was incomplete."));
          return;
        }

        settled = true;
        close();
        resolve(result);
      };
      channel.port1.onmessageerror = () => {
        fail(new Error("Offline package response could not be decoded."));
      };
      channel.port1.start();

      try {
        target.postMessage(
          {
            type: "PWA_OFFLINE_PACKAGE_START",
            protocol: 1,
            requestId,
          },
          [channel.port2],
        );
      } catch (error) {
        fail(
          error instanceof Error
            ? error
            : new Error("Unable to start the full offline package."),
        );
      }
    });
  });

  expect(completion.state).toBe("complete");
  expect(completion.cachedEntries).toBeGreaterThan(0);
  expect(completion.cachedEntries).toBe(completion.totalEntries);
  expect(completion.cachedBytes).toBe(completion.totalBytes);
}

test("生产构建通过真实 Operation 与 Worker 执行全部六个内置模板", async ({
  page,
}) => {
  await trackWorkers(page);
  await openRuntimeProbe(page);

  const jsonValue = { ready: true, count: 3 };
  const yamlValue = { service: "local", enabled: true, ports: [80, 443] };
  const csvValue = [
    { name: "alpha", count: "2" },
    { name: "beta", count: "3" },
  ];
  const callback =
    "https://example.test/callback?code=local-code&state=local-state#done";
  const jwtPayload = { sub: "local-user", role: "tester" };
  const jwt = `${base64UrlJson({ alg: "HS256", typ: "JWT" })}.${base64UrlJson(jwtPayload)}.c2ln`;

  const executions: Array<{
    id: WorkflowTemplateId;
    input: SerializableWorkflowInput;
  }> = [
    {
      id: "base64-json-inspect",
      input: {
        kind: "text",
        text: Buffer.from(JSON.stringify(jsonValue), "utf8").toString("base64"),
      },
    },
    {
      id: "yaml-config-to-base64url",
      input: {
        kind: "text",
        text: "service: local\nenabled: true\nports:\n  - 80\n  - 443\n",
      },
    },
    {
      id: "csv-api-fixture-sha256",
      input: { kind: "text", text: "name,count\nalpha,2\nbeta,3" },
    },
    {
      id: "encoded-callback-query-audit",
      input: { kind: "text", text: encodeURIComponent(callback) },
    },
    {
      id: "encoded-jwt-claims",
      input: { kind: "text", text: encodeURIComponent(jwt) },
    },
    {
      id: "png-palette-sha256",
      input: {
        kind: "rgba-image",
        width: 2,
        height: 2,
        data: [
          255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255,
        ],
      },
    },
  ];

  const output = new Map<WorkflowTemplateId, string>();
  for (const execution of executions) {
    const started = await startWorkflow(page, execution.id, execution.input);
    expect(started.templateId).toBe(execution.id);
    output.set(
      execution.id,
      textOutput(await waitForWorkflow(page, started.runId)),
    );
    await expectReleased(page);
  }

  expect(JSON.parse(output.get("base64-json-inspect") ?? "")).toEqual(
    jsonValue,
  );
  expect(
    JSON.parse(
      Buffer.from(
        output.get("yaml-config-to-base64url") ?? "",
        "base64url",
      ).toString("utf8"),
    ),
  ).toEqual(yamlValue);
  expect(output.get("csv-api-fixture-sha256")).toBe(
    createHash("sha256").update(JSON.stringify(csvValue)).digest("hex"),
  );

  const queryReport = JSON.parse(
    output.get("encoded-callback-query-audit") ?? "",
  ) as { parameters: Array<{ key: string; value: string }> };
  expect(queryReport.parameters).toEqual([
    expect.objectContaining({ key: "code", value: "local-code" }),
    expect.objectContaining({ key: "state", value: "local-state" }),
  ]);

  const jwtReport = JSON.parse(output.get("encoded-jwt-claims") ?? "") as {
    payload: unknown;
  };
  expect(jwtReport.payload).toEqual(jwtPayload);
  expect(output.get("png-palette-sha256")).toMatch(/^[a-f0-9]{64}$/u);

  const lifecycle = await page.evaluate(() => {
    const value = (window as RuntimeProbeWindow).__workflowWorkerLifecycle;
    if (value === undefined)
      throw new Error("Worker lifecycle is unavailable.");
    return { ...value, urls: [...value.urls] };
  });
  expect(lifecycle.created).toBeGreaterThanOrEqual(2);
  expect(lifecycle.terminated).toBe(lifecycle.created);
  expect(lifecycle.urls).toEqual(
    expect.arrayContaining([
      expect.stringMatching(/operation\.worker[-.][A-Za-z0-9_-]+\.js/u),
    ]),
  );
});

test("硬取消会同步终止当前 Worker 并清空 Vault 与运行资源", async ({
  page,
}) => {
  await trackWorkers(page);
  await openRuntimeProbe(page);

  const started = await page.evaluate(() => {
    const probe = (window as RuntimeProbeWindow).__onlineToolsWorkflowProbe;
    if (probe === undefined) throw new Error("Workflow probe is not ready.");
    const width = 2_048;
    const height = 2_048;
    const data = new Uint8ClampedArray(width * height * 4);
    data.fill(127);
    return probe.start("png-palette-sha256", {
      kind: "rgba-image",
      width,
      height,
      data,
    });
  });

  const cancellation = await page.evaluate((runId) => {
    const runtimeWindow = window as RuntimeProbeWindow;
    const probe = runtimeWindow.__onlineToolsWorkflowProbe;
    const lifecycle = runtimeWindow.__workflowWorkerLifecycle;
    if (probe === undefined || lifecycle === undefined) {
      throw new Error("Workflow or Worker probe is not ready.");
    }
    const terminatedBefore = lifecycle.terminated;
    const cancelled = probe.cancel(runId);
    return {
      cancelled,
      created: lifecycle.created,
      terminatedBefore,
      terminatedAfter: lifecycle.terminated,
    };
  }, started.runId);

  expect(cancellation.cancelled).toBe(true);
  expect(cancellation.created).toBeGreaterThanOrEqual(1);
  expect(cancellation.terminatedAfter).toBe(cancellation.terminatedBefore + 1);
  await expect
    .poll(() => runtimeSnapshot(page))
    .toMatchObject({
      activeRunCount: 0,
      vault: { entries: 0, bytes: 0, objectUrls: 0 },
      executor: {
        activeTaskCount: 0,
        activeWorkerCount: 0,
        activeMemoryBytes: 0,
        globalActiveTaskCount: 0,
        globalActiveWorkerCount: 0,
      },
    });

  expect(await waitForWorkflow(page, started.runId)).toMatchObject({
    ok: false,
    error: { name: "WorkflowError", code: "cancelled" },
  });
  await expectReleased(page);
});

test("配方导出不含正文，运行期间零业务外发且零持久化", async ({ page }) => {
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
  const runtimeUrlBefore = page.url();

  const storageState = () =>
    page.evaluate(async () => {
      const databases =
        typeof indexedDB.databases === "function"
          ? (await indexedDB.databases())
              .map((database) => database.name ?? "")
              .sort()
          : [];
      const cacheNames = (await caches.keys()).sort();
      const cacheRequests = (
        await Promise.all(
          cacheNames.map(async (name) => (await caches.open(name)).keys()),
        )
      )
        .flat()
        .map((request) => request.url)
        .sort();
      return {
        local: Object.entries(localStorage).sort(),
        session: Object.entries(sessionStorage).sort(),
        cookie: document.cookie,
        databases,
        cacheNames,
        cacheRequests,
      };
    });

  const storageBefore = await storageState();
  const canary = `OTH_WORKFLOW_CANARY_${Date.now()}_中文🙂`;
  captureRuntime = true;
  const execution = await page.evaluate(async (privateValue) => {
    const probe = (window as RuntimeProbeWindow).__onlineToolsWorkflowProbe;
    if (probe === undefined) throw new Error("Workflow probe is not ready.");
    const recipe = probe.exportRecipe("yaml-config-to-base64url");
    const started = probe.start("yaml-config-to-base64url", {
      kind: "text",
      text: `secret: ${JSON.stringify(privateValue)}\nready: true\n`,
    });
    const activeSnapshot = probe.snapshot();
    const result = await probe.wait(started.runId);
    return { recipe, activeSnapshot, result };
  }, canary);
  captureRuntime = false;

  expect(
    JSON.parse(
      Buffer.from(textOutput(execution.result), "base64url").toString("utf8"),
    ),
  ).toEqual({ secret: canary, ready: true });

  const canaryRepresentations = [
    canary,
    encodeURI(canary),
    encodeURIComponent(canary),
    Buffer.from(canary, "utf8").toString("base64"),
    Buffer.from(canary, "utf8").toString("base64url"),
    createHash("sha256").update(canary).digest("hex"),
  ];
  const recipeAndRuntimeState = `${execution.recipe}\n${JSON.stringify(execution.activeSnapshot)}`;
  for (const representation of canaryRepresentations) {
    expect(recipeAndRuntimeState).not.toContain(representation);
    expect(consoleEntries.join("\n")).not.toContain(representation);
    expect(page.url()).not.toContain(representation);
  }
  expect(page.url()).toBe(runtimeUrlBefore);

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
      // WebKit classifies a module Worker's immutable same-origin bootstrap as
      // XHR. No other data-transport endpoint is permitted.
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

  expect(await storageState()).toEqual(storageBefore);
  await expectReleased(page);
});

test("Chromium 主动下载完整离线包后可从六个公开页面执行模板", async ({
  browserName,
  context,
  page,
}) => {
  test.setTimeout(180_000);
  test.skip(browserName !== "chromium", "离线 Workflow 门禁在 Chromium 执行");

  await page.goto("./", { waitUntil: "networkidle" });
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload({ waitUntil: "networkidle" });
  await expect
    .poll(() =>
      page.evaluate(() => Boolean(navigator.serviceWorker.controller)),
    )
    .toBe(true);

  await downloadFullOfflinePackage(page);

  const offlineJwt = `${base64UrlJson({ alg: "none", typ: "JWT" })}.${base64UrlJson({ sub: "offline-user" })}.c2ln`;
  const textExecutions: ReadonlyArray<{
    id: Exclude<WorkflowTemplateId, "png-palette-sha256">;
    input: string;
  }> = [
    {
      id: "base64-json-inspect",
      input: Buffer.from('{"offline":true,"source":"cache"}', "utf8").toString(
        "base64",
      ),
    },
    {
      id: "yaml-config-to-base64url",
      input: "offline: true\nsource: cache\n",
    },
    {
      id: "csv-api-fixture-sha256",
      input: "name,offline\nhub,true\n",
    },
    {
      id: "encoded-callback-query-audit",
      input: encodeURIComponent(
        "https://example.test/callback?offline=true&source=cache",
      ),
    },
    {
      id: "encoded-jwt-claims",
      input: encodeURIComponent(offlineJwt),
    },
  ];

  await context.setOffline(true);
  try {
    for (const execution of textExecutions) {
      await page.goto(`./workflows/${execution.id}/`, {
        waitUntil: "networkidle",
      });
      await expect(page.locator("[data-workflow-studio]")).toBeVisible();
      const input = page.locator("[data-workflow-input]");
      await expect(input).toBeEnabled();
      await input.fill(execution.input);
      const run = page.locator('[data-action="run"]');
      await expect(run).toBeEnabled();
      await run.click();
      await expect(page.locator("[data-workflow-studio]")).toHaveAttribute(
        "data-runtime-status",
        "succeeded",
        { timeout: 30_000 },
      );
      await expect(
        page
          .locator('[data-step-preview] [data-preview-kind="text"] pre')
          .last(),
      ).toHaveText(/\S/u);
      await expect(
        page.locator('[data-workflow-feedback="success"]'),
      ).toBeVisible();
    }

    await page.goto("./workflows/png-palette-sha256/", {
      waitUntil: "networkidle",
    });
    await expect(page.locator("[data-workflow-studio]")).toBeVisible();
    const fileInput = page.locator("[data-batch-file-input]");
    await expect(fileInput).toBeEnabled();
    await fileInput.setInputFiles({
      name: "offline-fixture.png",
      mimeType: "image/png",
      buffer: PNG_FIXTURE,
    });
    await expect(page.locator("[data-batch-item]")).toHaveCount(1);
    await page.locator('[data-action="run-batch"]').click();
    await expect(page.locator("[data-workflow-batch]")).toHaveAttribute(
      "data-batch-status",
      "completed",
      { timeout: 30_000 },
    );
    await expect(page.locator('[data-item-status="succeeded"]')).toHaveCount(1);
    await expect(page.locator('[data-batch-feedback="success"]')).toBeVisible();
    await expect(page.locator('[data-action="download-result"]')).toBeEnabled();
  } finally {
    await context.setOffline(false);
  }
});

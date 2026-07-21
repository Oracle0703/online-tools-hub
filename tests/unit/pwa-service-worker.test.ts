import { createHash, webcrypto } from "node:crypto";
import vm from "node:vm";

import { describe, expect, it, vi } from "vitest";

import { createServiceWorkerSource } from "../../scripts/pwa-build-core.mjs";

type WorkerListener = (event: Record<string, unknown>) => void;

class MemoryCache {
  readonly entries = new Map<string, Response>();

  async match(request: Request): Promise<Response | undefined> {
    return this.entries.get(request.url)?.clone();
  }

  async put(request: Request, response: Response): Promise<void> {
    this.entries.set(request.url, response.clone());
  }

  async delete(request: Request): Promise<boolean> {
    return this.entries.delete(request.url);
  }
}

class MemoryCacheStorage {
  readonly stores = new Map<string, MemoryCache>();

  async open(name: string): Promise<MemoryCache> {
    let cache = this.stores.get(name);
    if (cache === undefined) {
      cache = new MemoryCache();
      this.stores.set(name, cache);
    }
    return cache;
  }

  async keys(): Promise<string[]> {
    return [...this.stores.keys()];
  }

  async delete(name: string): Promise<boolean> {
    return this.stores.delete(name);
  }
}

class TestMessagePort {
  readonly messages: unknown[] = [];
  closed = false;

  constructor(readonly onPost?: (value: unknown) => void) {}

  postMessage(value: unknown): void {
    this.messages.push(structuredClone(value));
    this.onPost?.(value);
  }

  close(): void {
    this.closed = true;
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function entry(url: string, body: string, kind: string) {
  return {
    url,
    bytes: Buffer.byteLength(body),
    sha256: sha256(body),
    kind,
  };
}

function requestLike(
  url: string,
  options: {
    mode?: string;
    destination?: string;
    method?: string;
    headers?: HeadersInit;
  } = {},
): Request {
  return {
    url,
    method: options.method ?? "GET",
    mode: options.mode ?? "cors",
    destination: options.destination ?? "",
    headers: new Headers(options.headers),
  } as unknown as Request;
}

function createWorkerHarness() {
  const origin = "https://example.test";
  const basePath = "/app/";
  const bodies = new Map<string, string>([
    [`${basePath}`, "home"],
    [`${basePath}offline.html`, "offline"],
    [`${basePath}assets/app.js`, "app-script"],
    [`${basePath}privacy-manifest.json`, '{"local":true}'],
  ]);
  const entries = [
    entry(`${basePath}`, bodies.get(`${basePath}`)!, "document"),
    entry(
      `${basePath}offline.html`,
      bodies.get(`${basePath}offline.html`)!,
      "document",
    ),
    entry(
      `${basePath}assets/app.js`,
      bodies.get(`${basePath}assets/app.js`)!,
      "script",
    ),
    entry(
      `${basePath}privacy-manifest.json`,
      bodies.get(`${basePath}privacy-manifest.json`)!,
      "data",
    ),
  ];
  const source = createServiceWorkerSource({
    basePath,
    version: "0123456789abcdef",
    entries,
    shellUrls: [`${basePath}`, `${basePath}offline.html`],
  });
  const listeners = new Map<string, WorkerListener>();
  const caches = new MemoryCacheStorage();
  const fetches: string[] = [];
  const blockedPaths = new Set<string>();
  const streamBlockedPaths = new Set<string>();
  let offline = false;

  const self = {
    location: { origin },
    clients: { claim: () => Promise.resolve() },
    skipWaiting: () => Promise.resolve(),
    addEventListener(type: string, listener: WorkerListener) {
      listeners.set(type, listener);
    },
  };
  const fetch = async (
    input: RequestInfo | URL,
    init: RequestInit = {},
  ): Promise<Response> => {
    const requestUrl =
      input instanceof Request
        ? input.url
        : typeof input === "object" &&
            input !== null &&
            "url" in input &&
            typeof input.url === "string"
          ? input.url
          : new Request(input).url;
    const url = new URL(requestUrl);
    fetches.push(url.pathname + url.search);
    if (offline) throw new TypeError("offline");
    if (blockedPaths.has(url.pathname)) {
      await new Promise<void>((resolve, reject) => {
        const signal = init.signal;
        if (signal?.aborted) {
          reject(new DOMException("aborted", "AbortError"));
          return;
        }
        signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
        void resolve;
      });
    }
    const body = bodies.get(url.pathname);
    if (body !== undefined && streamBlockedPaths.has(url.pathname)) {
      const bytes = new TextEncoder().encode(body);
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(bytes.slice(0, 1));
            init.signal?.addEventListener(
              "abort",
              () => controller.error(new DOMException("aborted", "AbortError")),
              { once: true },
            );
          },
        }),
        { status: 200 },
      );
    }
    return new Response(body ?? "missing", {
      status: body === undefined ? 404 : 200,
    });
  };

  vm.runInNewContext(source, {
    self,
    caches,
    fetch,
    crypto: webcrypto,
    URL,
    Request,
    Response,
    Headers,
    AbortController,
    DOMException,
    Object,
    TypeError,
    Uint8Array,
    ArrayBuffer,
    structuredClone,
  });

  async function dispatchExtendable(
    type: "install" | "activate",
  ): Promise<void> {
    const waits: Promise<unknown>[] = [];
    listeners.get(type)?.({
      waitUntil(value: Promise<unknown>) {
        waits.push(Promise.resolve(value));
      },
    });
    await Promise.all(waits);
  }

  function dispatchFetch(request: Request): Promise<Response> | undefined {
    let response: Promise<Response> | undefined;
    listeners.get("fetch")?.({
      request,
      respondWith(value: Promise<Response>) {
        response = Promise.resolve(value);
      },
    });
    return response;
  }

  function dispatchMessage(
    data: Record<string, unknown>,
    port = new TestMessagePort(),
  ): { port: TestMessagePort; done: Promise<void> } {
    const waits: Promise<unknown>[] = [];
    listeners.get("message")?.({
      data,
      ports: [port],
      source: { id: "client-1" },
      waitUntil(value: Promise<unknown>) {
        waits.push(Promise.resolve(value));
      },
    });
    return {
      port,
      done: Promise.all(waits).then(() => undefined),
    };
  }

  return {
    origin,
    basePath,
    bodies,
    caches,
    fetches,
    blockedPaths,
    streamBlockedPaths,
    dispatchExtendable,
    dispatchFetch,
    dispatchMessage,
    setOffline(value: boolean) {
      offline = value;
    },
  };
}

function protocolMessage(type: string, requestId: string) {
  return { type, protocol: 1, requestId };
}

describe("generated PWA Service Worker", () => {
  it("installs only the shell and writes only eligible verified subresources", async () => {
    const worker = createWorkerHarness();
    await worker.dispatchExtendable("install");

    expect(await worker.caches.keys()).toEqual([
      "online-tools-hub-shell-0123456789abcdef",
    ]);
    const shell = await worker.caches.open(
      "online-tools-hub-shell-0123456789abcdef",
    );
    expect([...shell.entries.keys()].sort()).toEqual([
      `${worker.origin}${worker.basePath}`,
      `${worker.origin}${worker.basePath}offline.html`,
    ]);

    const status = worker.dispatchMessage(
      protocolMessage("PWA_OFFLINE_STATUS", "status-1"),
    );
    await status.done;
    expect(status.port.messages).toEqual([
      expect.objectContaining({
        type: "PWA_OFFLINE_STATUS",
        state: "shell",
        cachedEntries: 2,
        missingEntries: 2,
      }),
    ]);

    const programmatic = worker.dispatchFetch(
      requestLike(`${worker.origin}${worker.basePath}assets/app.js`),
    );
    const queried = worker.dispatchFetch(
      requestLike(`${worker.origin}${worker.basePath}assets/app.js?private=1`, {
        destination: "script",
      }),
    );
    const posted = worker.dispatchFetch(
      requestLike(`${worker.origin}${worker.basePath}assets/app.js`, {
        method: "POST",
        destination: "script",
      }),
    );
    expect(programmatic).toBeUndefined();
    expect(queried).toBeUndefined();
    expect(posted).toBeUndefined();

    const scriptResponse = worker.dispatchFetch(
      requestLike(`${worker.origin}${worker.basePath}assets/app.js`, {
        destination: "script",
      }),
    );
    await expect(scriptResponse).resolves.toBeInstanceOf(Response);
    const content = await worker.caches.open(
      "online-tools-hub-content-0123456789abcdef",
    );
    expect([...content.entries.keys()]).toEqual([
      `${worker.origin}${worker.basePath}assets/app.js`,
    ]);
    expect(
      [...shell.entries.keys(), ...content.entries.keys()].every(
        (url) => new URL(url).search === "",
      ),
    ).toBe(true);
  });

  it("uses only the generic fallback for query navigation and resumes corrupt partial packages", async () => {
    const worker = createWorkerHarness();
    await worker.dispatchExtendable("install");
    worker.setOffline(true);
    const navigation = worker.dispatchFetch(
      requestLike(`${worker.origin}${worker.basePath}?private=canary`, {
        mode: "navigate",
        destination: "document",
      }),
    );
    await expect(navigation?.then((response) => response.text())).resolves.toBe(
      "offline",
    );
    worker.setOffline(false);

    const first = worker.dispatchMessage(
      protocolMessage("PWA_OFFLINE_PACKAGE_START", "package-1"),
    );
    await first.done;
    expect(first.port.closed).toBe(true);
    expect(first.port.messages.at(-1)).toEqual(
      expect.objectContaining({
        type: "PWA_OFFLINE_COMPLETE",
        state: "complete",
        cachedEntries: 4,
      }),
    );

    const content = await worker.caches.open(
      "online-tools-hub-content-0123456789abcdef",
    );
    await content.put(
      new Request(`${worker.origin}${worker.basePath}assets/app.js`),
      new Response("corrupt"),
    );
    const corruptStatus = worker.dispatchMessage(
      protocolMessage("PWA_OFFLINE_STATUS", "status-corrupt"),
    );
    await corruptStatus.done;
    expect(corruptStatus.port.messages).toEqual([
      expect.objectContaining({
        type: "PWA_OFFLINE_STATUS",
        state: "partial",
        cachedEntries: 3,
        missingEntries: 1,
      }),
    ]);
    expect(
      await content.match(
        new Request(`${worker.origin}${worker.basePath}assets/app.js`),
      ),
    ).toBeUndefined();

    const retry = worker.dispatchMessage(
      protocolMessage("PWA_OFFLINE_PACKAGE_START", "package-retry"),
    );
    await retry.done;
    expect(retry.port.messages.at(-1)).toEqual(
      expect.objectContaining({ type: "PWA_OFFLINE_COMPLETE" }),
    );

    const remove = worker.dispatchMessage(
      protocolMessage("PWA_OFFLINE_PACKAGE_REMOVE", "remove-1"),
    );
    await remove.done;
    expect(remove.port.messages).toEqual([
      expect.objectContaining({
        type: "PWA_OFFLINE_REMOVED",
        state: "shell",
        cachedEntries: 2,
      }),
    ]);
  });

  it("rejects poisoned cache hits and repairs static resources only from verified network bytes", async () => {
    const worker = createWorkerHarness();
    await worker.dispatchExtendable("install");
    const request = requestLike(
      `${worker.origin}${worker.basePath}assets/app.js`,
      { destination: "script" },
    );
    await expect(
      worker.dispatchFetch(request)?.then((response) => response.text()),
    ).resolves.toBe("app-script");

    const content = await worker.caches.open(
      "online-tools-hub-content-0123456789abcdef",
    );
    await content.put(
      new Request(`${worker.origin}${worker.basePath}assets/app.js`),
      new Response("malicious-script"),
    );
    await expect(
      worker.dispatchFetch(request)?.then((response) => response.text()),
    ).resolves.toBe("app-script");
    await expect(
      content
        .match(new Request(`${worker.origin}${worker.basePath}assets/app.js`))
        .then((response) => response?.text()),
    ).resolves.toBe("app-script");

    await content.put(
      new Request(`${worker.origin}${worker.basePath}assets/app.js`),
      new Response("malicious-script"),
    );
    worker.setOffline(true);
    await expect(worker.dispatchFetch(request)).rejects.toThrow("offline");
    expect(
      await content.match(
        new Request(`${worker.origin}${worker.basePath}assets/app.js`),
      ),
    ).toBeUndefined();
  });

  it("never serves poisoned documents or a poisoned generic offline fallback", async () => {
    const worker = createWorkerHarness();
    await worker.dispatchExtendable("install");
    const shell = await worker.caches.open(
      "online-tools-hub-shell-0123456789abcdef",
    );
    await shell.put(
      new Request(`${worker.origin}${worker.basePath}`),
      new Response("malicious-document"),
    );
    await shell.put(
      new Request(`${worker.origin}${worker.basePath}offline.html`),
      new Response("malicious-fallback"),
    );

    worker.setOffline(true);
    const response = await worker.dispatchFetch(
      requestLike(`${worker.origin}${worker.basePath}`, {
        mode: "navigate",
        destination: "document",
      }),
    );
    expect(response?.status).toBe(0);
    await expect(response?.text()).resolves.toBe("");
    expect([...shell.entries.keys()]).toEqual([]);
  });

  it("hard-cancels a serial package job and retains completed public entries", async () => {
    const worker = createWorkerHarness();
    await worker.dispatchExtendable("install");
    worker.blockedPaths.add(`${worker.basePath}assets/app.js`);

    const start = worker.dispatchMessage(
      protocolMessage("PWA_OFFLINE_PACKAGE_START", "cancel-me"),
    );
    await vi.waitFor(
      () => {
        expect(worker.fetches).toContain(`${worker.basePath}assets/app.js`);
      },
      { timeout: 2_000, interval: 10 },
    );

    const cancel = worker.dispatchMessage(
      protocolMessage("PWA_OFFLINE_PACKAGE_CANCEL", "cancel-me"),
    );
    await cancel.done;
    await start.done;
    expect(cancel.port.messages).toEqual([
      expect.objectContaining({
        type: "PWA_OFFLINE_CANCEL_ACK",
        accepted: true,
      }),
    ]);
    expect(start.port.messages.at(-1)).toEqual(
      expect.objectContaining({
        type: "PWA_OFFLINE_CANCELLED",
        state: "shell",
      }),
    );
    expect(start.port.closed).toBe(true);
  });

  it("reports cancellation while a response body stream is still being read", async () => {
    const worker = createWorkerHarness();
    await worker.dispatchExtendable("install");
    worker.streamBlockedPaths.add(`${worker.basePath}assets/app.js`);

    const start = worker.dispatchMessage(
      protocolMessage("PWA_OFFLINE_PACKAGE_START", "cancel-stream"),
    );
    await vi.waitFor(() => {
      expect(worker.fetches).toContain(`${worker.basePath}assets/app.js`);
    });
    const cancel = worker.dispatchMessage(
      protocolMessage("PWA_OFFLINE_PACKAGE_CANCEL", "cancel-stream"),
    );
    await cancel.done;
    await start.done;

    expect(cancel.port.messages).toEqual([
      expect.objectContaining({
        type: "PWA_OFFLINE_CANCEL_ACK",
        accepted: true,
      }),
    ]);
    expect(start.port.messages.at(-1)).toEqual(
      expect.objectContaining({ type: "PWA_OFFLINE_CANCELLED" }),
    );
  });

  it("reports COMPLETE when cancellation races with the final verified entry", async () => {
    const worker = createWorkerHarness();
    await worker.dispatchExtendable("install");
    let cancel: ReturnType<typeof worker.dispatchMessage> | undefined;
    const startPort = new TestMessagePort((value) => {
      if (
        cancel === undefined &&
        typeof value === "object" &&
        value !== null &&
        Reflect.get(value, "type") === "PWA_OFFLINE_PROGRESS" &&
        Reflect.get(value, "completedEntries") === 4
      ) {
        cancel = worker.dispatchMessage(
          protocolMessage("PWA_OFFLINE_PACKAGE_CANCEL", "cancel-at-complete"),
        );
      }
    });
    const start = worker.dispatchMessage(
      protocolMessage("PWA_OFFLINE_PACKAGE_START", "cancel-at-complete"),
      startPort,
    );
    await start.done;
    await cancel?.done;

    expect(cancel?.port.messages).toEqual([
      expect.objectContaining({
        type: "PWA_OFFLINE_CANCEL_ACK",
        accepted: true,
      }),
    ]);
    expect(start.port.messages.at(-1)).toEqual(
      expect.objectContaining({
        type: "PWA_OFFLINE_COMPLETE",
        state: "complete",
      }),
    );
  });
});

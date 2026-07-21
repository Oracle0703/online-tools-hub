import { describe, expect, it, vi } from "vitest";

import {
  PrivacyObservationAbortedError,
  awaitPrivacyObservation,
  capturePrivacyObservableState,
  readBoundedResponseText,
  type PrivacyObservationEnvironment,
} from "../../src/privacy/observation";

function environment(
  overrides: Partial<PrivacyObservationEnvironment> = {},
): PrivacyObservationEnvironment {
  return {
    origin: "https://example.test",
    href: "https://example.test/online-tools-hub/privacy/",
    historyState: null,
    cookie: "",
    localStorage: {},
    sessionStorage: {},
    indexedDB: { databases: async () => [] },
    caches: {
      keys: async () => [],
      open: async () => ({
        keys: async () => [],
        match: async () => undefined,
      }),
    },
    ...overrides,
  };
}

describe("privacy observation", () => {
  it("scans every cache name and response body regardless of MIME", async () => {
    const canary = "OTH_PRIVACY_SELF_TEST_binary_canary";
    const request = new Request(
      "https://example.test/online-tools-hub/assets/app.bin",
    );
    const open = vi.fn(async (name: string) => ({
      keys: async () => [request],
      match: async () =>
        new Response(name === "other-project" ? canary : "safe", {
          headers: { "content-type": "application/octet-stream" },
        }),
    }));

    const result = await capturePrivacyObservableState({
      basePath: "/online-tools-hub/",
      signal: new AbortController().signal,
      representations: [canary],
      environment: environment({
        indexedDB: { databases: async () => [{ name: "metadata-only" }] },
        caches: {
          keys: async () => ["online-tools-hub-shell", "other-project"],
          open,
        },
      }),
    });

    expect(open).toHaveBeenCalledTimes(2);
    expect(open).toHaveBeenCalledWith("online-tools-hub-shell");
    expect(open).toHaveBeenCalledWith("other-project");
    expect(result.cacheResponseContainsSensitiveData).toBe(true);
    expect(result.serialized).toContain("metadata-only");
    expect(result.serialized).toContain("other-project");
  });

  it.each(["indexedDB", "cacheStorage"] as const)(
    "aborts a hanging %s enumeration without waiting for host settlement",
    async (stage) => {
      const controller = new AbortController();
      const never = new Promise<never>(() => undefined);
      const observation = capturePrivacyObservableState({
        basePath: "/online-tools-hub/",
        signal: controller.signal,
        representations: ["canary"],
        environment: environment(
          stage === "indexedDB"
            ? { indexedDB: { databases: () => never } }
            : { caches: { keys: () => never, open: vi.fn() } },
        ),
      });

      await Promise.resolve();
      controller.abort();
      await expect(observation).rejects.toBeInstanceOf(
        PrivacyObservationAbortedError,
      );
    },
  );

  it("does not start a host observation for a pre-aborted signal", async () => {
    const controller = new AbortController();
    const start = vi.fn(async () => "unreachable");
    controller.abort();

    await expect(
      awaitPrivacyObservation(controller.signal, start),
    ).rejects.toBeInstanceOf(PrivacyObservationAbortedError);
    expect(start).not.toHaveBeenCalled();
  });

  it("cancels an incomplete reader and always attempts to release its lock", async () => {
    const controller = new AbortController();
    const cancel = vi.fn(async () => undefined);
    const releaseLock = vi.fn();
    const response = {
      headers: new Headers(),
      body: {
        getReader: () => ({
          read: () => new Promise<never>(() => undefined),
          cancel,
          releaseLock,
        }),
      },
    } as unknown as Response;

    const reading = readBoundedResponseText(response, controller.signal, {
      value: 0,
    });
    await Promise.resolve();
    controller.abort();

    await expect(reading).rejects.toBeInstanceOf(
      PrivacyObservationAbortedError,
    );
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(releaseLock).toHaveBeenCalled();
  });

  it("releases a completed reader without cancelling it", async () => {
    const cancel = vi.fn(async () => undefined);
    const releaseLock = vi.fn();
    const read = vi
      .fn()
      .mockResolvedValueOnce({
        done: false,
        value: new TextEncoder().encode("ok"),
      })
      .mockResolvedValueOnce({ done: true, value: undefined });
    const response = {
      headers: new Headers(),
      body: { getReader: () => ({ read, cancel, releaseLock }) },
    } as unknown as Response;

    await expect(
      readBoundedResponseText(response, new AbortController().signal, {
        value: 0,
      }),
    ).resolves.toBe("ok");
    expect(cancel).not.toHaveBeenCalled();
    expect(releaseLock).toHaveBeenCalledTimes(1);
  });
});

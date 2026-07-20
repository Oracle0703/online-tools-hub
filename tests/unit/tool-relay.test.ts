import { describe, expect, it, vi } from "vitest";

import { buildToolRelayHref, relayToolOutput } from "../../src/lib/tool-relay";

describe("privacy-safe tool relay", () => {
  it.each([
    [
      "/online-tools-hub/",
      "json-formatter",
      "/online-tools-hub/tools/json-formatter/",
    ],
    [
      "online-tools-hub?preview=1",
      "query-params",
      "/online-tools-hub/tools/query-params/",
    ],
    ["/", "json-formatter", "/tools/json-formatter/"],
    ["", "query-params", "/tools/query-params/"],
  ])("builds a static same-site path from %s", (base, slug, expected) => {
    expect(buildToolRelayHref(base, slug)).toBe(expected);
  });

  it.each(["../private", "json/formatter", "JSON Formatter", "", "-tool"])(
    "rejects unsafe destination slug %s",
    (slug) => {
      expect(buildToolRelayHref("/online-tools-hub/", slug)).toBeNull();
    },
  );

  it("writes the exact output before navigating and never includes it in the URL", async () => {
    const events: string[] = [];
    const secret = 'PRIVATE_CANARY_{"token":"中文🙂"}';
    const writeText = vi.fn(async (value: string) => {
      events.push(`copy:${value}`);
    });
    const navigate = vi.fn((href: string) => {
      events.push(`navigate:${href}`);
    });
    const onCopied = vi.fn(() => events.push("copied"));

    const result = await relayToolOutput({
      value: secret,
      baseUrl: "/online-tools-hub/",
      targetSlug: "json-formatter",
      writeText,
      onCopied,
      navigate,
    });

    expect(result).toEqual({
      ok: true,
      href: "/online-tools-hub/tools/json-formatter/",
    });
    expect(events).toEqual([
      `copy:${secret}`,
      "copied",
      "navigate:/online-tools-hub/tools/json-formatter/",
    ]);
    expect(onCopied).toHaveBeenCalledOnce();
    expect(navigate.mock.calls[0]?.[0]).not.toContain(secret);
  });

  it("does nothing when output is empty or the target is invalid", async () => {
    const writeText = vi.fn(async () => undefined);
    const navigate = vi.fn();

    await expect(
      relayToolOutput({
        value: "",
        baseUrl: "/online-tools-hub/",
        targetSlug: "json-formatter",
        writeText,
        navigate,
      }),
    ).resolves.toMatchObject({ ok: false, reason: "empty-output" });
    await expect(
      relayToolOutput({
        value: "private",
        baseUrl: "/online-tools-hub/",
        targetSlug: "../unsafe",
        writeText,
        navigate,
      }),
    ).resolves.toMatchObject({ ok: false, reason: "invalid-target" });

    expect(writeText).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("does not navigate when clipboard support is missing or copying fails", async () => {
    const navigate = vi.fn();

    await expect(
      relayToolOutput({
        value: "private",
        baseUrl: "/online-tools-hub/",
        targetSlug: "json-formatter",
        navigate,
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: "clipboard-unavailable",
      message: expect.stringContaining("未打开目标工具"),
    });
    await expect(
      relayToolOutput({
        value: "private",
        baseUrl: "/online-tools-hub/",
        targetSlug: "json-formatter",
        writeText: async () => Promise.reject(new Error("denied")),
        navigate,
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: "clipboard-write-failed",
      message: expect.stringContaining("未打开目标工具"),
    });

    expect(navigate).not.toHaveBeenCalled();
  });

  it("reports a navigation failure only after a successful copy", async () => {
    const writeText = vi.fn(async () => undefined);

    await expect(
      relayToolOutput({
        value: "private",
        baseUrl: "/online-tools-hub/",
        targetSlug: "query-params",
        writeText,
        navigate: () => {
          throw new Error("blocked");
        },
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: "navigation-failed",
      message: expect.stringContaining("内容已复制"),
    });
    expect(writeText).toHaveBeenCalledWith("private");
  });
});

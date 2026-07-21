import { describe, expect, it } from "vitest";

import {
  PRIVACY_SELF_TEST_VERSION,
  privacySelfTestCheckIds,
  privacySelfTestCodes,
  runPrivacySelfTest,
} from "../../src/privacy/self-test";

describe("privacy self-test public contract", () => {
  it("returns a closed unsupported report outside a browser", async () => {
    const result = await runPrivacySelfTest();

    expect(result).toEqual({
      version: PRIVACY_SELF_TEST_VERSION,
      passed: false,
      code: "unsupported-environment",
      checks: privacySelfTestCheckIds.map((id) => ({
        id,
        passed: false,
        code: id === "environment" ? "unsupported-environment" : "not-run",
      })),
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.checks)).toBe(true);
    expect(JSON.stringify(result)).not.toContain("OTH_PRIVACY_SELF_TEST_");
  });

  it("treats abort, unsupported and invalid options as non-passing", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      runPrivacySelfTest({ signal: controller.signal }),
    ).resolves.toMatchObject({ passed: false, code: "cancelled" });
    await expect(runPrivacySelfTest({ timeoutMs: 0 })).resolves.toMatchObject({
      passed: false,
      code: "invalid-options",
    });
    expect(privacySelfTestCodes).toContain("unsupported-environment");
    expect(new Set(privacySelfTestCodes).size).toBe(
      privacySelfTestCodes.length,
    );
  });
});

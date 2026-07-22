import { describe, expect, it } from "vitest";

import {
  PRIVACY_MANIFEST_FORMAT,
  PRIVACY_MANIFEST_REQUIRED_EXCLUDES,
  PRIVACY_MANIFEST_SELF_TEST_NON_ASSESSMENTS,
  PrivacyManifestValidationError,
  assertPrivacyManifest,
  serializePrivacyManifest,
  validatePrivacyManifest,
} from "../../scripts/privacy-manifest-core.mjs";
import { GET } from "../../src/pages/privacy-manifest.json";
import { THEME_STORAGE_KEY, privacyManifest } from "../../src/privacy/manifest";
import { WORKFLOW_RECIPE_LIBRARY_STORAGE_KEY } from "../../src/lib/workflow-recipe-library";

type MutableManifestFixture = {
  [key: string]: unknown;
  scope: { excludes: string[] };
  data: { thirdPartyRuntime: string };
  selfTest: { doesNotAssess: string[] };
  allowedState: Array<{
    mayContainUserContent: boolean;
    constraints?: { query: string };
  }>;
  inventory: {
    tools: Array<{ id: string }>;
    operations: Array<{ id: string }>;
    workflows: Array<{ id: string; operationIds: string[] }>;
  };
};

function mutableManifest(): MutableManifestFixture {
  return JSON.parse(JSON.stringify(privacyManifest)) as MutableManifestFixture;
}

describe("privacy manifest", () => {
  it("publishes a deeply frozen, closed v1 contract", () => {
    expect(privacyManifest.format).toBe(PRIVACY_MANIFEST_FORMAT);
    expect(privacyManifest.version).toBe(1);
    expect(validatePrivacyManifest(privacyManifest)).toMatchObject({
      ok: true,
    });
    expect(Object.isFrozen(privacyManifest)).toBe(true);
    expect(Object.isFrozen(privacyManifest.inventory.operations)).toBe(true);
    expect(privacyManifest.scope.excludes).toEqual(
      PRIVACY_MANIFEST_REQUIRED_EXCLUDES,
    );
    expect(privacyManifest.selfTest.doesNotAssess).toEqual(
      PRIVACY_MANIFEST_SELF_TEST_NON_ASSESSMENTS,
    );
    expect(privacyManifest.data.thirdPartyRuntime).toBe(
      "bundled-dependencies-no-remote-code",
    );
  });

  it("derives complete, stable registry inventories", () => {
    expect(privacyManifest.inventory.tools).toHaveLength(13);
    expect(privacyManifest.inventory.operations).toHaveLength(13);
    expect(privacyManifest.inventory.workflows).toHaveLength(6);

    for (const inventory of [
      privacyManifest.inventory.tools,
      privacyManifest.inventory.operations,
      privacyManifest.inventory.workflows,
    ]) {
      const ids = inventory.map((entry) => entry.id);
      expect(ids).toEqual(
        [...ids].sort((left, right) => left.localeCompare(right, "en")),
      );
      expect(new Set(ids).size).toBe(ids.length);
    }

    const operationIds = new Set(
      privacyManifest.inventory.operations.map((operation) => operation.id),
    );
    for (const workflow of privacyManifest.inventory.workflows) {
      expect(workflow.operationIds.length).toBeGreaterThan(0);
      expect(
        workflow.operationIds.every((operationId) =>
          operationIds.has(operationId),
        ),
      ).toBe(true);
    }
  });

  it("allows only documented non-content browser state", () => {
    expect(privacyManifest.allowedState).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          storage: "local-storage",
          key: THEME_STORAGE_KEY,
          mayContainUserContent: false,
        }),
        expect.objectContaining({
          id: "workflow-recipe-library",
          storage: "local-storage",
          key: WORKFLOW_RECIPE_LIBRARY_STORAGE_KEY,
          fields: [
            "format",
            "version",
            "items",
            "id",
            "updatedAt",
            "recipe",
            "steps",
            "operationId",
            "options",
          ],
          mayContainUserContent: false,
        }),
        expect.objectContaining({
          storage: "local-storage",
          key: "online-tools-hub:tool-memory:v1",
          fields: ["version", "favorites", "recent", "slug", "at"],
          mayContainUserContent: false,
        }),
        expect.objectContaining({
          storage: "cache-storage",
          mayContainUserContent: false,
          constraints: {
            origin: "same-origin",
            method: "GET",
            query: "forbidden",
            source: "build-allowlist",
          },
        }),
        {
          id: "service-worker-registration",
          storage: "service-worker-registration",
          scope: "site-base",
          script: "same-origin-build-artifact",
          mayContainUserContent: false,
        },
      ]),
    );
  });

  it("serves the exact validated contract as machine JSON", async () => {
    const response = GET();
    expect(response.headers.get("content-type")).toBe(
      "application/json; charset=utf-8",
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    const body = await response.text();
    expect(body).toBe(serializePrivacyManifest(privacyManifest));
    expect(body.endsWith("\n")).toBe(true);
    expect(JSON.parse(body)).toEqual(privacyManifest);
  });

  it.each([
    [
      "unknown root field",
      (value: MutableManifestFixture) => (value.extra = true),
    ],
    [
      "content persistence",
      (value: MutableManifestFixture) =>
        (value.allowedState[0]!.mayContainUserContent = true),
    ],
    [
      "incomplete claim boundary",
      (value: MutableManifestFixture) => value.scope.excludes.pop(),
    ],
    [
      "incomplete self-test boundary",
      (value: MutableManifestFixture) => value.selfTest.doesNotAssess.pop(),
    ],
    [
      "false third-party runtime claim",
      (value: MutableManifestFixture) =>
        (value.data.thirdPartyRuntime = "none"),
    ],
    [
      "query cache policy",
      (value: MutableManifestFixture) =>
        (value.allowedState[3]!.constraints!.query = "allowed"),
    ],
    [
      "missing tool coverage",
      (value: MutableManifestFixture) => value.inventory.tools.shift(),
    ],
    [
      "unknown workflow operation",
      (value: MutableManifestFixture) =>
        value.inventory.workflows[0]!.operationIds.push("unknown.operation"),
    ],
    [
      "unstable tool order",
      (value: MutableManifestFixture) => value.inventory.tools.reverse(),
    ],
    [
      "unstable operation order",
      (value: MutableManifestFixture) => value.inventory.operations.reverse(),
    ],
    [
      "unstable workflow order",
      (value: MutableManifestFixture) => value.inventory.workflows.reverse(),
    ],
  ])("rejects %s", (_name, mutate) => {
    const value = mutableManifest();
    mutate(value);
    const result = validatePrivacyManifest(value);
    expect(result.ok).toBe(false);
    expect(() => assertPrivacyManifest(value)).toThrow(
      PrivacyManifestValidationError,
    );
  });

  it("returns validation failures instead of throwing for hostile shapes", () => {
    for (const value of [
      null,
      [],
      1,
      { ...mutableManifest(), inventory: null },
    ]) {
      expect(() => validatePrivacyManifest(value)).not.toThrow();
      expect(validatePrivacyManifest(value).ok).toBe(false);
    }
  });
});

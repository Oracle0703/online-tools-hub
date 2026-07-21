import { describe, expect, it } from "vitest";

import {
  WORKFLOW_RECIPE_FORMAT,
  WORKFLOW_RECIPE_VERSION,
} from "../../src/workflows/contract";
import {
  createWorkflowPrivacyReceipt,
  exportWorkflowPrivacyReceiptCanonical,
  WORKFLOW_PRIVACY_RECEIPT_FORMAT,
  WORKFLOW_PRIVACY_RECEIPT_VERSION,
  type WorkflowReceiptSource,
} from "../../src/workflows/receipt";

function source(
  items: WorkflowReceiptSource["items"] = [],
  times: Pick<WorkflowReceiptSource, "startedAt" | "completedAt"> = {
    startedAt: 1_700_000_000_000,
    completedAt: 1_700_000_001_000,
  },
): WorkflowReceiptSource {
  return {
    recipe: {
      format: WORKFLOW_RECIPE_FORMAT,
      version: WORKFLOW_RECIPE_VERSION,
      steps: [
        { operationId: "json.format", options: { indent: 2 } },
        { operationId: "base64.encode", options: { variant: "standard" } },
      ],
    },
    ...times,
    items,
  };
}

describe("workflow privacy receipt", () => {
  it("records only a public recipe, operation IDs, counts, timing and local-only claims", () => {
    const receipt = createWorkflowPrivacyReceipt(
      source([
        { status: "succeeded" },
        { status: "failed", errorCode: "operation-failed" },
        { status: "cancelled", errorCode: "cancelled" },
      ]),
    );

    expect(receipt).toMatchObject({
      format: WORKFLOW_PRIVACY_RECEIPT_FORMAT,
      version: WORKFLOW_PRIVACY_RECEIPT_VERSION,
      localOnly: true,
      capabilities: {
        processing: "local-only",
        network: "forbidden",
        persistence: "forbidden",
      },
      operationIds: ["json.format", "base64.encode"],
      startedAt: "2023-11-14T22:13:20.000Z",
      completedAt: "2023-11-14T22:13:21.000Z",
      status: "completed-with-errors",
      summary: {
        total: 3,
        pending: 0,
        running: 0,
        succeeded: 1,
        failed: 1,
        cancelled: 1,
      },
      items: [
        { status: "succeeded" },
        { status: "failed", errorCode: "operation-failed" },
        { status: "cancelled", errorCode: "cancelled" },
      ],
    });
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Object.isFrozen(receipt.capabilities)).toBe(true);
    expect(Object.isFrozen(receipt.recipe)).toBe(true);
    expect(Object.isFrozen(receipt.operationIds)).toBe(true);
    expect(Object.isFrozen(receipt.summary)).toBe(true);
    expect(Object.isFrozen(receipt.items)).toBe(true);
    expect(Object.isFrozen(receipt.items[0])).toBe(true);

    const json = JSON.stringify(receipt);
    expect(json).not.toMatch(
      /original-file|private-body|payloadId|vaultId|itemId|digest/iu,
    );
  });

  it("derives every stable aggregate status without item identifiers", () => {
    expect(
      createWorkflowPrivacyReceipt(
        source([], { startedAt: null, completedAt: null }),
      ).status,
    ).toBe("not-started");
    expect(
      createWorkflowPrivacyReceipt(
        source([{ status: "pending" }, { status: "pending" }], {
          startedAt: null,
          completedAt: null,
        }),
      ).status,
    ).toBe("not-started");
    expect(
      createWorkflowPrivacyReceipt(
        source([{ status: "running" }, { status: "pending" }], {
          startedAt: 1000,
          completedAt: null,
        }),
      ).status,
    ).toBe("running");
    expect(
      createWorkflowPrivacyReceipt(source([{ status: "succeeded" }])).status,
    ).toBe("succeeded");
    expect(
      createWorkflowPrivacyReceipt(
        source([{ status: "cancelled", errorCode: "cancelled" }]),
      ).status,
    ).toBe("cancelled");
  });

  it("exports a canonical v1 envelope in construction order", () => {
    const value = exportWorkflowPrivacyReceiptCanonical(
      source([{ status: "failed", errorCode: "input-failed" }]),
    );
    expect(
      value.startsWith('{"format":"online-tools-hub/privacy-receipt"'),
    ).toBe(true);
    expect(JSON.parse(value)).toEqual(
      createWorkflowPrivacyReceipt(
        source([{ status: "failed", errorCode: "input-failed" }]),
      ),
    );
  });

  it("rejects invalid timestamps and chronology", () => {
    for (const startedAt of [-1, Number.NaN, 8_640_000_000_000_001]) {
      expect(() =>
        createWorkflowPrivacyReceipt(
          source([], { startedAt, completedAt: null }),
        ),
      ).toThrow(RangeError);
    }
    expect(() =>
      createWorkflowPrivacyReceipt(
        source([], { startedAt: 2000, completedAt: 1000 }),
      ),
    ).toThrow("completedAt must not precede startedAt.");
  });

  it("accepts only bounded known item states and stable error codes", () => {
    expect(() =>
      createWorkflowPrivacyReceipt(
        source([{ status: "secret-state" as never }]),
      ),
    ).toThrow(TypeError);
    expect(() =>
      createWorkflowPrivacyReceipt(
        source([{ status: "failed", errorCode: "private-file-name" as never }]),
      ),
    ).toThrow(TypeError);
    expect(() => createWorkflowPrivacyReceipt(source([null as never]))).toThrow(
      TypeError,
    );
    expect(() =>
      createWorkflowPrivacyReceipt(
        source(Array.from({ length: 65 }, () => ({ status: "pending" }))),
      ),
    ).toThrow(TypeError);

    const sparse = new Array(1) as WorkflowReceiptSource["items"];
    expect(() => createWorkflowPrivacyReceipt(source(sparse))).toThrow(
      TypeError,
    );
    expect(() =>
      createWorkflowPrivacyReceipt(
        source([{ status: "pending", privateName: "secret" } as never]),
      ),
    ).toThrow(TypeError);
  });

  it("rejects accessors and extra receipt fields without invoking them", () => {
    let getterCalls = 0;
    const unsafe = source();
    Object.defineProperty(unsafe, "recipe", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return { privateBody: "secret" };
      },
    });
    expect(() => createWorkflowPrivacyReceipt(unsafe)).toThrow(TypeError);
    expect(getterCalls).toBe(0);

    expect(() =>
      createWorkflowPrivacyReceipt({
        ...source(),
        fileName: "secret",
      } as never),
    ).toThrow(TypeError);
  });

  it("revalidates the recipe and never copies runtime-only properties", () => {
    const invalid = source();
    (invalid.recipe as Record<string, unknown>).payload = "private-body";
    expect(() => createWorkflowPrivacyReceipt(invalid)).toThrow(
      expect.objectContaining({ code: "invalid-recipe" }),
    );
  });
});

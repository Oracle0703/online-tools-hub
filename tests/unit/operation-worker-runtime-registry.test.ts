import { describe, expect, it } from "vitest";

import { operationIds } from "../../src/operations/catalog";
import {
  loadWorkerOperationDefinition,
  QR_OPERATION_ID,
  workerOperationLoaderIds,
} from "../../src/operations/worker-runtime-registry";

describe("shared Worker Operation registry", () => {
  it("covers every catalog Operation except the dedicated QR entry", () => {
    expect(QR_OPERATION_ID).toBe("qr.transform");
    expect(workerOperationLoaderIds).toEqual(
      operationIds.filter((operationId) => operationId !== QR_OPERATION_ID),
    );
    expect(workerOperationLoaderIds).not.toContain(QR_OPERATION_ID);
  });

  it.each(workerOperationLoaderIds)(
    "loads the shared %s definition behind its isolated lazy loader",
    async (operationId) => {
      await expect(
        loadWorkerOperationDefinition(operationId),
      ).resolves.toMatchObject({
        manifest: { id: operationId },
        execute: expect.any(Function),
      });
    },
  );

  it("rejects QR or unknown IDs", async () => {
    await expect(
      loadWorkerOperationDefinition(QR_OPERATION_ID),
    ).rejects.toMatchObject({
      code: "unknown-operation",
    });
    await expect(
      loadWorkerOperationDefinition("unknown.operation"),
    ).rejects.toMatchObject({
      code: "unknown-operation",
    });
  });
});

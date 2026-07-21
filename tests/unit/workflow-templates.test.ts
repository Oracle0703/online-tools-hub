import { Buffer } from "node:buffer";

import { afterEach, describe, expect, it } from "vitest";

import type {
  OperationDefinition,
  OperationInput,
  OperationManifest,
} from "../../src/operations/contract";
import {
  getOperationManifest,
  operationIds,
} from "../../src/operations/catalog";
import {
  getActiveOperationMemoryBytes,
  getActiveOperationTaskCount,
  getActiveOperationWorkerCount,
  OperationExecutor,
} from "../../src/operations/executor";
import { loadOperationDefinition } from "../../src/operations/runtime-registry";
import { exportWorkflowRecipeCanonical } from "../../src/workflows/recipe-codec";
import { PayloadVault } from "../../src/workflows/payload-vault";
import { compileWorkflowCandidate } from "../../src/workflows/planner";
import { WorkflowRunner } from "../../src/workflows/runner";
import {
  getWorkflowTemplate,
  workflowTemplateIds,
  workflowTemplates,
  type WorkflowTemplateId,
} from "../../src/workflows/templates";

const runners: WorkflowRunner[] = [];

afterEach(() => {
  for (const runner of runners.splice(0)) runner.dispose();
  expect(getActiveOperationMemoryBytes()).toBe(0);
  expect(getActiveOperationTaskCount()).toBe(0);
  expect(getActiveOperationWorkerCount()).toBe(0);
});

function mainThreadManifest(source: OperationManifest): OperationManifest {
  return {
    ...source,
    execution: {
      ...source.execution,
      strategy: "main",
      workerThresholdBytes: null,
    },
  };
}

function createRealRunner(): WorkflowRunner {
  const manifests = new Map(
    operationIds.map((operationId) => {
      const manifest = getOperationManifest(operationId)!;
      return [operationId, mainThreadManifest(manifest)] as const;
    }),
  );
  let taskSequence = 0;
  const executor = new OperationExecutor({
    maxActiveMemoryBytes: 512 * 1024 * 1024,
    maxActiveWorkers: 0,
    taskIdFactory: () => `template-task-${++taskSequence}`,
    getManifest: (operationId) => manifests.get(operationId),
    async loadDefinition(operationId): Promise<OperationDefinition> {
      const definition = await loadOperationDefinition(operationId);
      return {
        manifest: manifests.get(operationId)!,
        execute: definition.execute,
      };
    },
  });
  let payloadSequence = 0;
  const vault = new PayloadVault({
    idFactory: () => `template-payload-${++payloadSequence}`,
  });
  const runner = new WorkflowRunner({
    executor,
    vault,
    disposeExecutor: true,
    runIdFactory: () => "template-run",
  });
  runners.push(runner);
  return runner;
}

function base64Url(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function templateInput(id: WorkflowTemplateId): OperationInput {
  switch (id) {
    case "base64-json-inspect":
      return {
        kind: "text",
        text: Buffer.from('{"ready":true,"count":2}', "utf8").toString(
          "base64",
        ),
      };
    case "yaml-config-to-base64url":
      return { kind: "text", text: "ready: true\ncount: 2\n" };
    case "csv-api-fixture-sha256":
      return { kind: "text", text: "name,ready\nhub,true\n" };
    case "encoded-callback-query-audit":
      return {
        kind: "text",
        text: encodeURIComponent(
          "https://example.test/callback?code=abc&scope=read&scope=write",
        ),
      };
    case "encoded-jwt-claims": {
      const jwt = `${base64Url({ alg: "none", typ: "JWT" })}.${base64Url({ sub: "local-user", exp: 4_102_444_800 })}.c2ln`;
      return { kind: "text", text: encodeURIComponent(jwt) };
    }
    case "png-palette-sha256":
      return {
        kind: "rgba-image",
        width: 1,
        height: 1,
        data: new Uint8ClampedArray([17, 34, 51, 255]),
      };
  }
}

describe("built-in workflow templates", () => {
  it("publishes exactly six deeply frozen, private recipes", () => {
    expect(workflowTemplateIds).toHaveLength(6);
    expect(workflowTemplates.map(({ id }) => id)).toEqual(workflowTemplateIds);
    expect(getWorkflowTemplate("missing-template")).toBeUndefined();

    for (const template of workflowTemplates) {
      expect(getWorkflowTemplate(template.id)).toBe(template);
      expect(Object.isFrozen(template)).toBe(true);
      expect(Object.isFrozen(template.recipe.steps)).toBe(true);
      expect(template.notices.length).toBeGreaterThan(0);

      const exported = exportWorkflowRecipeCanonical(template.recipe);
      expect(exported).not.toMatch(
        /(?:payload|result|preview|status|inputPayloadId|outputPayloadId)/u,
      );
      expect(JSON.parse(exported)).toEqual(template.recipe);
    }
  });

  it.each(workflowTemplateIds)(
    "runs %s end-to-end through real Operation adapters without a Worker",
    async (templateId) => {
      const template = getWorkflowTemplate(templateId)!;
      const runner = createRealRunner();
      const input = templateInput(templateId);
      const initial = runner.vault.put(input, template.input.contentType);
      const plan = compileWorkflowCandidate(template.recipe);

      const result = await runner.start(plan, initial.id).promise;
      const preview = runner.vault.preview(result.finalPayloadId);

      expect(result.snapshot.status).toBe("succeeded");
      expect(
        result.snapshot.steps.every((step) => step.status === "succeeded"),
      ).toBe(true);
      expect(preview.kind).toBe("text");
      if (preview.kind !== "text") throw new Error("Expected text output.");

      if (templateId === "base64-json-inspect") {
        expect(JSON.parse(preview.text)).toEqual({ ready: true, count: 2 });
      } else if (templateId === "yaml-config-to-base64url") {
        expect(
          JSON.parse(Buffer.from(preview.text, "base64url").toString("utf8")),
        ).toEqual({ ready: true, count: 2 });
      } else if (
        templateId === "csv-api-fixture-sha256" ||
        templateId === "png-palette-sha256"
      ) {
        expect(preview.text).toMatch(/^[0-9a-f]{64}$/u);
      } else if (templateId === "encoded-callback-query-audit") {
        const report = JSON.parse(preview.text) as {
          parameters: Array<{ key: string; value: string }>;
        };
        expect(report.parameters).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ key: "code", value: "abc" }),
            expect.objectContaining({ key: "scope", value: "read" }),
            expect.objectContaining({ key: "scope", value: "write" }),
          ]),
        );
      } else {
        const report = JSON.parse(preview.text) as {
          header: { alg: string };
          payload: { sub: string };
        };
        expect(report.header.alg).toBe("none");
        expect(report.payload.sub).toBe("local-user");
      }

      expect(runner.snapshot().activeRunCount).toBe(0);
      expect(runner.snapshot().executor.activeTaskCount).toBe(0);
    },
  );
});

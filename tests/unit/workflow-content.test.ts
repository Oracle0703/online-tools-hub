import { describe, expect, it } from "vitest";

import {
  getWorkflowContent,
  getWorkflowContentStaticPaths,
  toWorkflowContentSummary,
  workflowContents,
} from "../../src/lib/workflow-content";
import { workflowTemplates } from "../../src/workflows/templates";

describe("workflow public content", () => {
  it("publishes one unique, substantive page for every runtime template", () => {
    expect(workflowContents).toHaveLength(6);
    expect(new Set(workflowContents.map(({ id }) => id))).toEqual(
      new Set(workflowTemplates.map(({ id }) => id)),
    );
    expect(new Set(workflowContents.map(({ slug }) => slug)).size).toBe(
      workflowContents.length,
    );

    for (const workflow of workflowContents) {
      const template = workflowTemplates.find(({ id }) => id === workflow.id);
      expect(template).toBeDefined();
      expect(workflow.title).toBe(template?.title);
      expect(workflow.description.length).toBeGreaterThan(45);
      expect(workflow.keywords.length).toBeGreaterThanOrEqual(5);
      expect(workflow.relatedToolSlugs.length).toBeGreaterThan(0);
      expect(workflow.steps.map(({ operationId }) => operationId)).toEqual(
        template?.recipe.steps.map(({ operationId }) => operationId),
      );
      expect(workflow.notices.length).toBeGreaterThan(0);
      expect(Object.isFrozen(workflow)).toBe(true);
      expect(Object.isFrozen(workflow.steps)).toBe(true);
      expect(Object.isFrozen(workflow.steps[0])).toBe(true);
    }
  });

  it("builds all static routes and lookup entries without exposing recipes", () => {
    expect(getWorkflowContentStaticPaths()).toEqual(
      workflowContents.map((workflow) => ({
        params: { slug: workflow.slug },
        props: { workflow },
      })),
    );
    expect(getWorkflowContent("encoded-jwt-claims")?.mark).toBe("JWT");
    expect(getWorkflowContent("missing")).toBeUndefined();

    const summary = toWorkflowContentSummary(workflowContents[0]!);
    expect(summary).toMatchObject({
      id: "base64-json-inspect",
      stepCount: 2,
      inputLabel: "标准 Base64 文本",
    });
    expect(summary).not.toHaveProperty("steps");
    expect(summary).not.toHaveProperty("description");
    expect(summary).not.toHaveProperty("recipe");
  });

  it("keeps public claims aligned with the local privacy boundary", () => {
    const serialized = JSON.stringify(workflowContents);
    expect(serialized).toContain("本地");
    expect(serialized).toContain("不上传");
    expect(serialized).not.toMatch(
      /(?:内容会上传|在云端执行|自动远程抓取|已经验证签名|配方保存正文)/u,
    );
  });
});

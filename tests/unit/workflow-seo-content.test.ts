import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { workflowContents } from "../../src/lib/workflow-content";

describe("workflow content and SEO contract", () => {
  it("gives every curated workflow a visible purpose, fit and privacy boundary", () => {
    for (const workflow of workflowContents) {
      expect(workflow.purpose.length).toBeGreaterThan(35);
      expect(workflow.useCases).toHaveLength(2);
      expect(workflow.limitations).toHaveLength(2);
      expect(workflow.privacyNote.length).toBeGreaterThan(30);
      expect(workflow.useCases.every((useCase) => useCase.length >= 18)).toBe(
        true,
      );
      expect(
        workflow.limitations.every((limitation) => limitation.length >= 18),
      ).toBe(true);
      expect(workflow.privacyNote).toMatch(
        /(?:当前标签页|本地 Worker|不会上传|不会被上传|不会产生任何网络请求)/u,
      );
      expect(Object.isFrozen(workflow.useCases)).toBe(true);
      expect(Object.isFrozen(workflow.limitations)).toBe(true);
    }
  });

  it("keeps workflow pages canonical and connects page, app, HowTo and breadcrumb entities", async () => {
    const [indexPage, detailPage, customPage] = await Promise.all([
      readFile("src/pages/workflows/index.astro", "utf8"),
      readFile("src/pages/workflows/[slug].astro", "utf8"),
      readFile("src/pages/workflows/new.astro", "utf8"),
    ]);

    expect(indexPage).toContain('"@type": "CollectionPage"');
    expect(indexPage).toContain('"@type": "ItemList"');
    expect(indexPage).toContain('"@type": "BreadcrumbList"');
    expect(indexPage).toContain("canonical={pageUrl}");

    for (const type of [
      "WebPage",
      "SoftwareApplication",
      "HowTo",
      "HowToStep",
      "BreadcrumbList",
    ]) {
      expect(detailPage).toContain(`"@type": "${type}"`);
    }
    expect(detailPage).toContain('mainEntity: { "@id": applicationId }');
    expect(detailPage).toContain('hasPart: { "@id": howToId }');
    expect(detailPage).toContain('breadcrumb: { "@id": breadcrumbId }');
    expect(detailPage).toContain("canonical={pageUrl}");
    expect(detailPage).toContain("{workflow.purpose}");
    expect(detailPage).toContain("workflow.useCases.map");
    expect(detailPage).toContain("workflow.limitations.map");
    expect(detailPage).toContain("{workflow.privacyNote}");

    for (const type of [
      "WebPage",
      "SoftwareApplication",
      "HowTo",
      "HowToStep",
      "BreadcrumbList",
    ]) {
      expect(customPage).toContain(`"@type": "${type}"`);
    }
    expect(customPage).toContain('pathFor("/workflows/new/")');
    expect(customPage).toContain("canonical={pageUrl}");
    expect(customPage).toContain("输入与执行范围");
    expect(customPage).toContain("配方不含正文");
    expect(customPage).toContain(
      "<WorkflowStudio client:load baseUrl={import.meta.env.BASE_URL} />",
    );
    expect(customPage).not.toContain("templateId=");
  });
});

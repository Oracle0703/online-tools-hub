import { describe, expect, it } from "vitest";

import {
  getGuidesForWorkflow,
  getGuidesForTool,
  getGuideStaticPaths,
  guides,
} from "../../src/lib/guide-content";
import { getToolBySlug } from "../../src/lib/tool-registry";
import { getWorkflowContent } from "../../src/lib/workflow-content";

describe("knowledge center content", () => {
  it("publishes ten unique, substantive static guides", () => {
    expect(guides).toHaveLength(10);
    expect(new Set(guides.map((guide) => guide.slug)).size).toBe(guides.length);
    expect(getGuideStaticPaths().map((route) => route.params.slug)).toEqual(
      guides.map((guide) => guide.slug),
    );

    for (const guide of guides) {
      expect(guide.title.length).toBeGreaterThan(12);
      expect(guide.description.length).toBeGreaterThan(25);
      expect(guide.sections.length).toBeGreaterThanOrEqual(3);
      expect(guide.keywords.length).toBeGreaterThanOrEqual(4);
      expect(guide.readingMinutes).toBeGreaterThanOrEqual(2);
      expect(guide.readingMinutes).toBeLessThanOrEqual(4);
      const articleText = guide.sections
        .flatMap((section) => [
          section.title,
          ...section.paragraphs,
          ...("points" in section ? section.points : []),
          "callout" in section ? section.callout : "",
        ])
        .join("");
      expect(articleText.length).toBeGreaterThan(300);
    }
  });

  it("publishes the QR safety guide and links it to the QR tool", () => {
    const guide = guides.find(
      (candidate) => candidate.slug === "qr-code-local-scan-safety",
    );

    expect(guide?.relatedToolSlugs).toEqual(["qr-code"]);
    expect(guide?.sections.map((section) => section.title).join(" ")).toContain(
      "识别时不要自动访问结果",
    );
  });

  it("links every guide to existing tools and supports reverse lookup", () => {
    for (const guide of guides) {
      expect(guide.relatedToolSlugs.length).toBeGreaterThan(0);
      for (const slug of guide.relatedToolSlugs) {
        expect(
          getToolBySlug(slug),
          `${guide.slug} 引用了不存在的工具`,
        ).toBeDefined();
        expect(getGuidesForTool(slug)).toContain(guide);
      }
    }
  });

  it("validates every declared curated workflow relationship", () => {
    for (const guide of guides) {
      for (const slug of guide.relatedWorkflowSlugs) {
        expect(
          getWorkflowContent(slug),
          `${guide.slug} 引用了不存在的工作流`,
        ).toBeDefined();
        expect(getGuidesForWorkflow(slug)).toContain(guide);
      }
    }
  });
});

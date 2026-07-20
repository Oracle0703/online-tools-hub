import { describe, expect, it } from "vitest";

import {
  getGuidesForTool,
  getGuideStaticPaths,
  guides,
} from "../../src/lib/guide-content";
import { getToolBySlug } from "../../src/lib/tool-registry";

describe("knowledge center content", () => {
  it("publishes eight unique, substantive static guides", () => {
    expect(guides).toHaveLength(8);
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
});

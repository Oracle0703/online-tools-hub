import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { guides } from "../../src/lib/guide-content";
import { categories, enabledTools } from "../../src/lib/tool-registry";

const projectUrl = "https://oracle0703.github.io/online-tools-hub";

describe("SEO assets", () => {
  it("keeps the sitemap equal to the complete indexable route set", async () => {
    const sitemap = await readFile("public/sitemap.xml", "utf8");
    const locations = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/gu)].map(
      (match) => match[1],
    );
    const activeCategorySlugs = categories
      .filter((category) =>
        enabledTools.some((tool) => tool.category === category.slug),
      )
      .map((category) => category.slug);
    const expectedLocations = [
      `${projectUrl}/`,
      `${projectUrl}/tools/`,
      ...enabledTools.map((tool) => `${projectUrl}/tools/${tool.slug}/`),
      `${projectUrl}/guides/`,
      ...guides.map((guide) => `${projectUrl}/guides/${guide.slug}/`),
      `${projectUrl}/categories/`,
      ...activeCategorySlugs.map((slug) => `${projectUrl}/categories/${slug}/`),
      `${projectUrl}/privacy/`,
      `${projectUrl}/about/`,
      `${projectUrl}/changelog/`,
    ];

    expect(locations).toHaveLength(new Set(locations).size);
    expect(new Set(locations)).toEqual(new Set(expectedLocations));
    expect(sitemap).toMatch(/^<\?xml version="1\.0" encoding="UTF-8"\?>/u);
    expect(sitemap.trimEnd()).toMatch(/<\/urlset>$/u);
  });

  it("publishes a 1200 × 630 social preview image", async () => {
    const image = await readFile("public/og-image.png");

    expect(image.subarray(1, 4).toString("ascii")).toBe("PNG");
    expect(image.readUInt32BE(16)).toBe(1200);
    expect(image.readUInt32BE(20)).toBe(630);
  });
});

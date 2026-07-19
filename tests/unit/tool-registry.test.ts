import { describe, expect, it } from "vitest";

import {
  bytesToDisplay,
  categories,
  enabledTools,
  getCategoryBySlug,
  getToolBySlug,
  getToolsByCategory,
  pathFor,
  toToolSummary,
} from "../../src/lib/tool-registry";

describe("tool registry", () => {
  it("keeps enabled tool slugs unique and assigned to known categories", () => {
    const slugs = enabledTools.map((tool) => tool.slug);
    const categorySlugs = new Set(categories.map((category) => category.slug));

    expect(new Set(slugs).size).toBe(slugs.length);
    expect(enabledTools).toHaveLength(5);
    expect(enabledTools.every((tool) => categorySlugs.has(tool.category))).toBe(
      true,
    );
    expect(enabledTools.every((tool) => tool.privacyMode === "local")).toBe(
      true,
    );
    expect(getToolBySlug("json-formatter")?.status).toBe("available");
    expect(
      enabledTools
        .filter((tool) => tool.slug !== "json-formatter")
        .every((tool) => tool.status === "planned"),
    ).toBe(true);
  });

  it("looks up tools and categories without exposing disabled entries", () => {
    expect(getToolBySlug("json-formatter")?.shortTitle).toBe("JSON 格式化");
    expect(getToolBySlug("missing-tool")).toBeUndefined();
    expect(getCategoryBySlug("encode-decode")?.title).toBe("编码与解码");
    expect(getCategoryBySlug("missing-category")).toBeUndefined();
    expect(
      getToolsByCategory("encode-decode").map((tool) => tool.slug),
    ).toEqual(["base64-codec", "url-codec"]);
    expect(getToolsByCategory("missing-category")).toEqual([]);
  });

  it("creates serializable summaries without the lazy component loader", () => {
    const summary = toToolSummary(enabledTools[0]!);

    expect(summary.slug).toBe("json-formatter");
    expect(summary).not.toHaveProperty("load");
    expect(enabledTools[0]).toHaveProperty("load");
  });

  it("creates base-aware route and asset paths", () => {
    expect(pathFor()).toMatch(/\/$/);
    expect(pathFor("/tools/json-formatter")).toMatch(
      /\/tools\/json-formatter\/$/,
    );
    expect(pathFor("/favicon.svg")).toMatch(/\/favicon\.svg$/);
  });

  it("formats configured byte limits for people", () => {
    expect(bytesToDisplay()).toBeUndefined();
    expect(bytesToDisplay(512)).toBe("512 B");
    expect(bytesToDisplay(4 * 1024)).toBe("4 KiB");
    expect(bytesToDisplay(2 * 1024 * 1024)).toBe("2 MiB");
  });
});

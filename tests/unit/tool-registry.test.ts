import { describe, expect, it } from "vitest";

import {
  bytesToDisplay,
  categories,
  enabledTools,
  getCategoryBySlug,
  getCategoryStaticPaths,
  getToolBySlug,
  getToolStaticPaths,
  getToolsByCategory,
  hasCompleteNetworkDisclosure,
  pathFor,
  toToolSummary,
} from "../../src/lib/tool-registry";

describe("tool registry", () => {
  it("keeps enabled tool slugs unique and assigned to known categories", () => {
    const slugs = enabledTools.map((tool) => tool.slug);
    const categorySlugs = new Set(categories.map((category) => category.slug));

    expect(new Set(slugs).size).toBe(slugs.length);
    expect(enabledTools).toHaveLength(10);
    expect(enabledTools.every((tool) => categorySlugs.has(tool.category))).toBe(
      true,
    );
    expect(enabledTools.every((tool) => tool.privacyMode === "local")).toBe(
      true,
    );
    expect(getToolBySlug("json-formatter")?.status).toBe("available");
    expect(getToolBySlug("image-compressor")?.limits.maxFileBytes).toBe(
      20 * 1024 * 1024,
    );
    expect(enabledTools.every((tool) => tool.status === "available")).toBe(
      true,
    );
    expect(enabledTools.every(hasCompleteNetworkDisclosure)).toBe(true);
    expect(
      enabledTools.every((tool) =>
        ["input", "output", "execute", "clear"].every((capability) =>
          tool.capabilities.includes(
            capability as (typeof tool.capabilities)[number],
          ),
        ),
      ),
    ).toBe(true);
  });

  it("requires every network tool to disclose its provider and sent fields", () => {
    const networkTool = {
      ...enabledTools[0]!,
      privacyMode: "network" as const,
    };

    expect(hasCompleteNetworkDisclosure(networkTool)).toBe(false);
    expect(
      hasCompleteNetworkDisclosure({
        ...networkTool,
        network: {
          providerName: "Example API",
          providerUrl: "https://api.example.com",
          sentFields: ["查询关键词"],
          purpose: "查询公开数据",
          trigger: "用户点击查询按钮",
        },
      }),
    ).toBe(true);
  });

  it("derives every static route from the registries", () => {
    const toolRoutes = getToolStaticPaths();
    const categoryRoutes = getCategoryStaticPaths();

    expect(toolRoutes.map((route) => route.params.slug)).toEqual(
      enabledTools.map((tool) => tool.slug),
    );
    expect(toolRoutes.every((route) => route.props.tool.enabled)).toBe(true);
    expect(
      toolRoutes.some((route) => route.params.slug === "missing-tool"),
    ).toBe(false);
    expect(categoryRoutes.map((route) => route.params.slug)).toEqual(
      categories.map((category) => category.slug),
    );
  });

  it("looks up tools and categories without exposing disabled entries", () => {
    expect(getToolBySlug("json-formatter")?.shortTitle).toBe("JSON 格式化");
    expect(getToolBySlug("missing-tool")).toBeUndefined();
    expect(getCategoryBySlug("encode-decode")?.title).toBe("编码与解码");
    expect(getCategoryBySlug("files-images")?.title).toBe("文件与图片");
    expect(getCategoryBySlug("missing-category")).toBeUndefined();
    expect(
      getToolsByCategory("encode-decode").map((tool) => tool.slug),
    ).toEqual(["base64-codec", "url-codec"]);
    expect(getToolsByCategory("files-images").map((tool) => tool.slug)).toEqual(
      ["image-compressor"],
    );
    expect(
      getToolsByCategory("text-processing").map((tool) => tool.slug),
    ).toEqual(["text-diff"]);
    expect(
      getToolsByCategory("security-hash").map((tool) => tool.slug),
    ).toEqual(["hash-generator", "jwt-decoder"]);
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

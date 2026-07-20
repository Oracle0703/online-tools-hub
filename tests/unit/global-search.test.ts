import { describe, expect, it } from "vitest";

import { homeTaskRecipes } from "../../src/lib/experience-content";
import {
  getGlobalSearchGroups,
  normalizeSearchText,
  toGlobalSearchGuide,
  toGlobalSearchTask,
} from "../../src/lib/global-search";
import { guides } from "../../src/lib/guide-content";
import {
  categories,
  enabledTools,
  toToolSummary,
} from "../../src/lib/tool-registry";
import {
  createEmptyToolMemory,
  TOOL_MEMORY_VERSION,
  type ToolMemoryState,
} from "../../src/lib/tool-memory";

const tools = enabledTools.map(toToolSummary);
const searchGuides = guides.map(toGlobalSearchGuide);
const tasks = homeTaskRecipes.map(toGlobalSearchTask);

function search(query: string, memory = createEmptyToolMemory()) {
  return getGlobalSearchGroups({
    tools,
    categories,
    guides: searchGuides,
    tasks,
    memory,
    query,
  });
}

function idsFor(query: string, groupId: string): string[] {
  return (
    search(query)
      .find((group) => group.id === groupId)
      ?.results.map((result) => result.id) ?? []
  );
}

describe("global search", () => {
  it("normalizes full-width characters, punctuation and letter case", () => {
    expect(normalizeSearchText("  ＪＳＯＮ／Base64_URL  ")).toBe(
      "json base64 url",
    );
  });

  it("builds serializable guide and task summaries", () => {
    const guide = toGlobalSearchGuide(guides[0]);
    const task = toGlobalSearchTask(homeTaskRecipes[0]);

    expect(guide).toMatchObject({
      slug: "base64-is-not-encryption",
      readingMinutes: 3,
    });
    expect(guide).not.toHaveProperty("sections");
    expect(task).toMatchObject({
      id: "read-api-response",
      toolSlug: "json-formatter",
    });
  });

  it("searches tools with Chinese task aliases and multiple tokens", () => {
    expect(idsFor("表格转接口数据", "tool")[0]).toBe("tool:csv-json-converter");
    expect(idsFor("接口 返回", "tool")).toContain("tool:json-formatter");
    expect(idsFor("秒 毫秒", "tool")).toContain("tool:unix-timestamp");
  });

  it("finds guides and common tasks by their real problem language", () => {
    expect(idsFor("验签", "guide")).toContain("guide:jwt-decode-vs-verify");
    expect(idsFor("令牌过期", "task")).toContain("task:inspect-jwt-claims");
    expect(idsFor("前导零", "task")).toContain("task:convert-csv-api-data");
  });

  it("puts favorites and recent tools first without duplicating them", () => {
    const memory: ToolMemoryState = {
      version: TOOL_MEMORY_VERSION,
      favorites: [{ slug: "jwt-decoder", at: 30 }],
      recent: [
        { slug: "json-formatter", at: 20 },
        { slug: "jwt-decoder", at: 10 },
      ],
    };
    const groups = search("", memory);
    const shortcuts = groups.find((group) => group.id === "shortcut");
    const toolResults = groups.find((group) => group.id === "tool")?.results;

    expect(groups.map((group) => group.id)).toEqual([
      "shortcut",
      "tool",
      "guide",
      "task",
    ]);
    expect(shortcuts?.results.map((result) => result.id)).toEqual([
      "shortcut:jwt-decoder",
      "shortcut:json-formatter",
    ]);
    expect(shortcuts?.results[0]?.meta).toBe("已收藏 · 最近使用");
    expect(
      toolResults?.some((result) => result.id === "tool:jwt-decoder"),
    ).toBe(false);
    expect(
      toolResults?.some((result) => result.id === "tool:json-formatter"),
    ).toBe(false);
  });

  it("uses tool affinity to order related guides and tasks", () => {
    const memory: ToolMemoryState = {
      version: TOOL_MEMORY_VERSION,
      favorites: [{ slug: "query-params", at: 10 }],
      recent: [],
    };
    const groups = search("URL", memory);
    const guideResults = groups.find((group) => group.id === "guide")?.results;
    const taskResults = groups.find((group) => group.id === "task")?.results;

    expect(guideResults?.[0]?.id).toBe("guide:url-query-parameters");
    expect(taskResults?.[0]?.id).toBe("task:inspect-query-parameters");
  });

  it("returns no groups for an unrelated query", () => {
    expect(search("完全不存在的内容 xyz987")).toEqual([]);
  });
});

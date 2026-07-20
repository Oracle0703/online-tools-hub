import { describe, expect, it } from "vitest";

import { enabledTools } from "../../src/lib/tool-registry";
import {
  getToolRuntimeRegistration,
  loadToolRuntime,
  toolRuntimeRegistry,
} from "../../src/lib/tool-runtime";

describe("tool runtime component map", () => {
  it("provides exactly one lazy UI loader for every enabled catalog tool", () => {
    expect(Object.keys(toolRuntimeRegistry)).toEqual(
      enabledTools.map((tool) => tool.slug),
    );

    for (const tool of enabledTools) {
      const registration = getToolRuntimeRegistration(tool.slug);
      expect(registration?.load).toBeTypeOf("function");
      expect(registration?.stylesheet).toBeTypeOf("string");
    }
    expect(getToolRuntimeRegistration("missing-tool")).toBeUndefined();
  });

  it("rejects unknown slugs before attempting a runtime import", async () => {
    await expect(loadToolRuntime("missing-tool")).rejects.toThrow(
      "Missing runtime component for tool: missing-tool",
    );
  });
});

import { describe, expect, it } from "vitest";

describe("GitHub Pages deployment configuration", () => {
  it("uses the repository subpath as Astro's default base", async () => {
    const { default: config } = await import("../../astro.config.mjs");

    expect(config.site).toBe("https://oracle0703.github.io");
    expect(config.base).toBe("/online-tools-hub");
    expect(config.output ?? "static").toBe("static");
  });
});

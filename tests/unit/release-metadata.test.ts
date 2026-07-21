import { readFile, stat } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { currentRelease, releases } from "../../src/lib/experience-content";

describe("v1 release metadata", () => {
  it("keeps package, changelog and structured-data versions aligned", async () => {
    const packageMetadata = JSON.parse(
      await readFile("package.json", "utf8"),
    ) as { version: string };

    expect(currentRelease).toBe(releases[0]);
    expect(currentRelease.version).toBe("1.0.0");
    expect(packageMetadata.version).toBe(currentRelease.version);
    expect(new Set(releases.map(({ version }) => version)).size).toBe(
      releases.length,
    );
    expect(
      releases.every(
        (release, index) =>
          index === 0 || release.date <= releases[index - 1]!.date,
      ),
    ).toBe(true);
  });

  it("does not publish a partial English route tree", async () => {
    const sitemap = await readFile("public/sitemap.xml", "utf8");
    const englishRouteExists = await stat("src/pages/en").then(
      () => true,
      () => false,
    );

    expect(englishRouteExists).toBe(false);
    expect(sitemap).not.toMatch(/\/online-tools-hub\/en(?:\/|<)/u);
    expect(sitemap).not.toMatch(/hreflang=["']en(?:-|["'])/u);
  });
});

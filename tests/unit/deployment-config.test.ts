import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("GitHub Pages deployment configuration", () => {
  it("uses the repository subpath as Astro's default base", async () => {
    const { default: config } = await import("../../astro.config.mjs");

    expect(config.site).toBe("https://oracle0703.github.io");
    expect(config.base).toBe("/online-tools-hub");
    expect(config.output ?? "static").toBe("static");
  });

  it("builds once per workflow and reuses the verified artifact", async () => {
    const [ci, deploy, releaseCandidate] = await Promise.all([
      readFile(".github/workflows/ci.yml", "utf8"),
      readFile(".github/workflows/deploy.yml", "utf8"),
      readFile(".github/workflows/release-candidate.yml", "utf8"),
    ]);

    expect(ci.match(/run: npm run build/gu)).toHaveLength(1);
    expect(ci).toContain("name: verified-site");
    expect(ci).toContain("overwrite: true");
    expect(ci).toContain(
      "name: playwright-report-${{ matrix.browser }}-${{ github.run_attempt }}",
    );
    expect(ci).toContain("name: lighthouse-reports-${{ github.run_attempt }}");
    expect(ci.match(/actions\/download-artifact@/gu)).toHaveLength(2);

    expect(deploy).not.toContain("run: npm run build");
    expect(deploy).toContain(
      "github.event.workflow_run.conclusion == 'success'",
    );
    expect(deploy).toContain("github.event.workflow_run.event == 'push'");
    expect(deploy).toContain("github.event.workflow_run.head_branch == 'main'");
    expect(deploy).toContain(
      "github.event.workflow_run.head_repository.full_name == github.repository",
    );
    expect(deploy).toContain("run-id: ${{ github.event.workflow_run.id }}");
    expect(deploy).toContain("name: verified-site");
    expect(deploy).toContain(
      'run: echo "name=github-pages-${{ github.run_attempt }}" >> "$GITHUB_OUTPUT"',
    );
    expect(deploy).toContain(
      "pages_artifact_name: ${{ steps.artifact_name.outputs.name }}",
    );
    expect(deploy).toContain(
      "artifact_name: ${{ needs.package.outputs.pages_artifact_name }}",
    );
    expect(deploy).not.toContain(
      "artifact_name: github-pages-${{ github.run_attempt }}",
    );

    expect(releaseCandidate.match(/run: npm run build/gu)).toHaveLength(1);
    expect(
      releaseCandidate.match(/actions\/download-artifact@/gu),
    ).toHaveLength(3);
    expect(releaseCandidate).toContain("overwrite: true");
    expect(releaseCandidate).toContain(
      "name: release-evidence-edge-windows-${{ github.run_attempt }}",
    );
    expect(releaseCandidate).toContain(
      "name: release-evidence-safari-macos-${{ github.run_attempt }}",
    );
    expect(releaseCandidate).toContain(
      "name: Aggregate and verify v1.0 release evidence",
    );
    expect(releaseCandidate).toContain(
      "run: node scripts/verify-release-evidence.mjs",
    );
    expect(releaseCandidate).toContain(
      "name: release-evidence-v1-${{ github.run_attempt }}",
    );
  });

  it("covers workflow and privacy release surfaces in Lighthouse and real browsers", async () => {
    const [lighthouse, realBrowser] = await Promise.all([
      readFile(".lighthouserc.cjs", "utf8"),
      readFile("scripts/real-browser-smoke.mjs", "utf8"),
    ]);

    for (const route of [
      "/workflows/",
      "/workflows/base64-json-inspect/",
      "/workflows/png-palette-sha256/",
      "/privacy/",
      "/changelog/",
    ]) {
      expect(lighthouse).toContain(
        `http://127.0.0.1:4321/online-tools-hub${route}`,
      );
      expect(realBrowser).toContain(`"${route}"`);
    }

    for (const assertion of [
      "workflowInteraction",
      "workflowClear",
      "workflowNoExternalRequests",
      "workflowMobile360NoOverflow",
      "privacyCenter",
    ]) {
      expect(realBrowser).toContain(`evidence.assertions.${assertion}`);
    }
  });
});

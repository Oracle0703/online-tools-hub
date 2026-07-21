import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const RELEASE_TARGET = "0a611e42d0617ff586b9d8cdae2c60454eac6f2e";

describe("v1.0 release publication", () => {
  it("publishes an idempotent release for the immutable v1.0 merge commit", async () => {
    const workflow = await readFile(
      ".github/workflows/publish-release.yml",
      "utf8",
    );

    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("branches: [main]");
    expect(workflow).toContain("contents: write");
    expect(workflow).toContain("RELEASE_TAG: v1.0.0");
    expect(workflow).toContain(`RELEASE_TARGET: ${RELEASE_TARGET}`);
    expect(workflow).toContain(
      'git merge-base --is-ancestor "$RELEASE_TARGET" origin/main',
    );
    expect(workflow).toContain(
      'test "$(git rev-list -n 1 "$RELEASE_TAG")" = "$RELEASE_TARGET"',
    );
    expect(workflow).toContain('gh release view "$RELEASE_TAG"');
    expect(workflow).toContain('gh release create "$RELEASE_TAG"');
    expect(workflow).toContain("--verify-tag");
    expect(workflow).toContain("--latest");
    expect(workflow).not.toMatch(/git (?:push|tag).*--force/u);
  });

  it("ships complete versioned notes without overstating the privacy boundary", async () => {
    const notes = await readFile("docs/releases/v1.0.0.md", "utf8");

    for (const section of [
      "## 主要变化",
      "## 隐私与安全边界",
      "## 发布验证",
      "## 使用与升级",
      "## 已知限制",
    ]) {
      expect(notes).toContain(section);
    }

    expect(notes).toContain(RELEASE_TARGET);
    expect(notes).toContain("1,122 项单元测试");
    expect(notes).toContain("真正的空白 Studio 与本地配方库属于 v1.1");
    expect(notes).not.toMatch(/(?:绝对安全|完全匿名|第三方安全认证)/u);
  });
});

import { describe, expect, it } from "vitest";

import { getToolPageContent } from "../../src/lib/tool-content";
import { enabledTools } from "../../src/lib/tool-registry";

describe("tool page content", () => {
  it("provides unique guides and FAQ content for every enabled tool", () => {
    const contents = enabledTools.map((tool) => getToolPageContent(tool.slug));

    expect(contents).toHaveLength(enabledTools.length);
    expect(new Set(contents.map((content) => content.guideTitle)).size).toBe(
      enabledTools.length,
    );

    for (const content of contents) {
      expect(content.steps).toHaveLength(3);
      expect(content.faqs).toHaveLength(3);
      expect(content.notice.length).toBeGreaterThan(20);
      expect(
        content.faqs.every(
          (faq) => faq.question.length > 5 && faq.answer.length > 15,
        ),
      ).toBe(true);
    }
  });

  it("rejects missing tool content so thin pages cannot be published", () => {
    expect(() => getToolPageContent("missing-tool")).toThrow(
      "Missing page content",
    );
  });

  it("keeps QR recognition results inside a plain-text safety boundary", () => {
    const content = getToolPageContent("qr-code");

    expect(content.notice).toContain("不会被验证或自动打开");
    expect(content.faqs.map((faq) => faq.answer).join(" ")).toContain(
      "不会导航、预取或请求",
    );
  });
});

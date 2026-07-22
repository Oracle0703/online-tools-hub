import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import WorkflowStudio, {
  customPlanNotices,
  resolveStudioInput,
  searchOperations,
} from "../../src/components/workflows/WorkflowStudio";
import { operationManifests } from "../../src/operations/catalog";

function renderBlankStudio(baseUrl?: string): string {
  return renderToStaticMarkup(createElement(WorkflowStudio, { baseUrl }));
}

describe("blank custom workflow studio", () => {
  it("renders zero steps without inheriting any source template", () => {
    const html = renderBlankStudio("/hub/");

    expect(html).toContain('data-template-id="custom"');
    expect(html).toContain('data-step-count="0"');
    expect(html).toContain("data-workflow-empty");
    expect(html).not.toContain("data-source-template-id");
    expect(html).not.toContain("Base64 只是编码，不是加密。");
    expect(html).toContain("这是 0 步空白配方");
    expect(html).toContain('data-policy-source="plan"');
    expect(html).toContain('data-input-kind="unsupported"');
  });

  it("exposes all thirteen local operations by Chinese label and full ID", () => {
    const html = renderBlankStudio();

    expect(operationManifests).toHaveLength(13);
    expect(html).toContain("data-operation-search");
    expect(html).toContain('data-operation-result-count="true"');
    expect(html).toContain('role="status" aria-live="polite"');
    expect(html).toContain("13/13 项");
    for (const manifest of operationManifests) {
      expect(html).toContain(`value="${manifest.id}"`);
      expect(html).toContain(`· ${manifest.id}`);
    }

    expect(searchOperations("Base64 解码").map((item) => item.id)).toEqual([
      "base64.codec",
    ]);
    expect(searchOperations("base64.codec").map((item) => item.id)).toEqual([
      "base64.codec",
    ]);
    expect(searchOperations("regex.test").map((item) => item.id)).toEqual([
      "regex.test",
    ]);
    expect(searchOperations("不存在的操作")).toEqual([]);
  });

  it("distinguishes a truly empty recipe from an invalid existing chain", () => {
    const emptyInput = resolveStudioInput(undefined, 0);
    const invalidInput = resolveStudioInput(undefined, 2);

    expect(emptyInput.reason).toContain("添加至少一个步骤");
    expect(invalidInput.reason).toContain("修复选项或类型衔接");
    expect(customPlanNotices(undefined, emptyInput, 0)[0]).toContain("0 步");
    expect(customPlanNotices(undefined, invalidInput, 2)[0]).toContain(
      "步骤链尚未通过校验",
    );
    expect(customPlanNotices(undefined, invalidInput, 2)[0]).not.toContain(
      "0 步",
    );
  });
});

import { describe, expect, it } from "vitest";

import {
  jsonToYaml,
  MAX_YAML_ALIAS_COUNT,
  MAX_YAML_JSON_INPUT_BYTES,
  transformYamlJson,
  yamlToJson,
} from "../../src/tools/yaml-json-converter";

const EXACT_TWO_TO_53 = 2 ** 53;

function expectFailure(result: ReturnType<typeof yamlToJson>, kind: string) {
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error.kind).toBe(kind);
    expect(result.error.line).toBeGreaterThanOrEqual(1);
    expect(result.error.column).toBeGreaterThanOrEqual(1);
    expect(result.error.pointer).toContain("^");
  }
}

describe("yamlToJson", () => {
  it("converts nested objects, Chinese text, arrays and scalar values", () => {
    const result = yamlToJson(`project: 在线工具箱
features:
  - YAML 转 JSON
  - 支持中文
settings:
  local: true
  retries: 3
  note: null`);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(JSON.parse(result.value)).toEqual({
        project: "在线工具箱",
        features: ["YAML 转 JSON", "支持中文"],
        settings: { local: true, retries: 3, note: null },
      });
    }
  });

  it("supports four-space JSON output", () => {
    expect(yamlToJson("items:\n  - one\n  - two", 4)).toEqual({
      ok: true,
      value: `{
    "items": [
        "one",
        "two"
    ]
}`,
    });
  });

  it.each([
    ["text", '"text"'],
    ["true", "true"],
    ["null", "null"],
    ["42", "42"],
    ["[one, two]", '[\n  "one",\n  "two"\n]'],
  ])("supports a top-level YAML scalar or sequence: %s", (input, output) => {
    expect(yamlToJson(input)).toEqual({ ok: true, value: output });
  });

  it("allows bounded aliases without preserving shared references", () => {
    const result = yamlToJson(`base: &base
  enabled: true
copy: *base`);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(JSON.parse(result.value)).toEqual({
        base: { enabled: true },
        copy: { enabled: true },
      });
    }
  });

  it("rejects alias expansion beyond the safety limit", () => {
    const aliases = Array.from(
      { length: MAX_YAML_ALIAS_COUNT + 1 },
      () => "  - *base",
    ).join("\n");
    const result = yamlToJson(`base: &base [1, 2, 3]\ncopies:\n${aliases}`);

    expectFailure(result, "alias-limit");
    if (!result.ok) expect(result.error.message).toContain("别名");
  });

  it("rejects circular aliases", () => {
    const result = yamlToJson("loop: &loop [*loop]");
    expectFailure(result, "alias-limit");
  });

  it("rejects unknown or executable-looking tags instead of resolving them", () => {
    for (const input of [
      "payload: !danger run-me",
      "payload: !!js/function 'function () { return 1 }'",
      "created: !!timestamp 2026-07-20",
    ]) {
      const result = yamlToJson(input);
      expectFailure(result, "syntax");
    }
  });

  it("does not execute merge keys when merge support is disabled", () => {
    const result = yamlToJson(`base: &base
  enabled: true
copy:
  <<: *base
  name: safe`);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(JSON.parse(result.value)).toEqual({
        base: { enabled: true },
        copy: { "<<": { enabled: true }, name: "safe" },
      });
    }
  });

  it("rejects multiple YAML documents at the second document boundary", () => {
    const result = yamlToJson("name: first\n---\nname: second");
    expectFailure(result, "multiple-documents");
    if (!result.ok) {
      expect(result.error).toMatchObject({ line: 2, column: 1 });
      expect(result.error.message).toContain("单个 YAML 文档");
    }
  });

  it("reports YAML syntax errors with line, column and nearby context", () => {
    const result = yamlToJson(`project: ok
items:
  - one
  - [two, three`);

    expectFailure(result, "syntax");
    if (!result.ok) {
      expect(result.error.line).toBe(4);
      expect(result.error.context).toContain("two, three");
    }
  });

  it("rejects duplicate and complex mapping keys", () => {
    for (const input of ["name: one\nname: two", "? [one, two]\n: value"]) {
      expectFailure(yamlToJson(input), "syntax");
    }
  });

  it.each(["value: .inf", "value: -.inf", "value: .nan"])(
    "rejects non-finite YAML numbers: %s",
    (input) => {
      expectFailure(yamlToJson(input), "unsupported-value");
    },
  );

  it("rejects excessive nesting", () => {
    const input = `${"[".repeat(102)}0${"]".repeat(102)}`;
    expectFailure(yamlToJson(input), "unsupported-value");
  });

  it("rejects blank and over-limit input", () => {
    expectFailure(yamlToJson(" \n\t"), "syntax");
    expectFailure(yamlToJson("# 只有注释"), "syntax");
    expectFailure(
      yamlToJson("x".repeat(MAX_YAML_JSON_INPUT_BYTES + 1)),
      "input-limit",
    );
  });

  it.each([
    ["value: 9007199254740993", 1, 8],
    ["value: 9007199254740993e0", 1, 8],
    ["value: 1000000000000000100", 1, 8],
    ["value: 1.0000000000000001", 1, 8],
    ["value: 0.10000000000000001", 1, 8],
    ["value: 4e-324", 1, 8],
    ["value: 1e400", 1, 8],
    ["items:\n  - safe\n  - 1.0000000000000001", 3, 5],
  ])(
    "rejects YAML numbers that would change during conversion: %s",
    (input, line, column) => {
      const result = yamlToJson(input);
      expectFailure(result, "unsupported-value");
      if (!result.ok) {
        expect(result.error).toMatchObject({ line, column });
        expect(result.error.message).toMatch(/保持原值|有限数字/u);
      }
    },
  );

  it.each([
    ["value: 9007199254740992", EXACT_TWO_TO_53],
    ["value: 9007199254740992e0", EXACT_TWO_TO_53],
    ["value: 1e21", 1e21],
    ["value: 1.0000000000000000", 1],
    ["value: 0.1", 0.1],
    ["value: 1.25e2", 125],
    ["value: 5e-324", 5e-324],
  ])(
    "preserves YAML numbers with a stable numeric round trip: %s",
    (input, expected) => {
      const result = yamlToJson(input);
      expect(result.ok).toBe(true);
      if (result.ok)
        expect(JSON.parse(result.value)).toEqual({ value: expected });
    },
  );
});

describe("jsonToYaml", () => {
  it("converts JSON objects and arrays while preserving Chinese text", () => {
    const source = {
      project: "在线工具箱",
      features: ["JSON 转 YAML", "支持中文"],
      settings: { local: true, note: null },
    };
    const yamlResult = jsonToYaml(JSON.stringify(source));

    expect(yamlResult.ok).toBe(true);
    if (yamlResult.ok) {
      expect(yamlResult.value).toContain("project: 在线工具箱");
      const roundTrip = yamlToJson(yamlResult.value);
      expect(roundTrip.ok).toBe(true);
      if (roundTrip.ok) expect(JSON.parse(roundTrip.value)).toEqual(source);
    }
  });

  it.each([
    ["null", "null\n"],
    ["true", "true\n"],
    ["42", "42\n"],
    ['"中文"', "中文\n"],
    ["[]", "[]\n"],
    ["{}", "{}\n"],
  ])("supports a top-level JSON value: %s", (input, output) => {
    expect(jsonToYaml(input)).toEqual({ ok: true, value: output });
  });

  it("preserves a __proto__ key as plain data", () => {
    const result = jsonToYaml('{"__proto__":{"polluted":true}}');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toContain("__proto__:");
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    }
  });

  it("reports stable JSON line and Unicode-aware column details", () => {
    const result = jsonToYaml('{\n  "😀": true,\n  "broken": nope\n}');
    expectFailure(result, "syntax");
    if (!result.ok) {
      expect(result.error).toMatchObject({ line: 3, column: 14 });
      expect(result.error.message).toContain("JSON 语法错误");
      expect(result.error.context).toContain("broken");
    }
  });

  it.each([
    ['{"value":9007199254740993}', 1, 10],
    ['{"value":9007199254740993e0}', 1, 10],
    ['{"value":1000000000000000100}', 1, 10],
    ['{"value":1.0000000000000001}', 1, 10],
    ['{"value":0.10000000000000001}', 1, 10],
    ['{"value":4e-324}', 1, 10],
    ['{"value":1e400}', 1, 10],
    ['{\n  "safe": 1,\n  "value": 1.0000000000000001\n}', 3, 12],
  ])(
    "rejects JSON numbers that would change during conversion: %s",
    (input, line, column) => {
      const result = jsonToYaml(input);
      expectFailure(result, "unsupported-value");
      if (!result.ok) {
        expect(result.error).toMatchObject({ line, column });
        expect(result.error.message).toContain("保持原值");
      }
    },
  );

  it("does not treat number-like text as a numeric precision risk", () => {
    expect(jsonToYaml('{"value":"9007199254740993"}').ok).toBe(true);
  });

  it.each([
    ['{"value":9007199254740992}', EXACT_TWO_TO_53],
    ['{"value":9007199254740992e0}', EXACT_TWO_TO_53],
    ['{"value":1e21}', 1e21],
    ['{"value":1.0000000000000000}', 1],
    ['{"value":0.1}', 0.1],
    ['{"value":1.25e2}', 125],
    ['{"value":5e-324}', 5e-324],
  ])(
    "preserves JSON numbers with a stable numeric round trip: %s",
    (input, expected) => {
      const yamlResult = jsonToYaml(input);
      expect(yamlResult.ok).toBe(true);
      if (yamlResult.ok) {
        const jsonResult = yamlToJson(yamlResult.value);
        expect(jsonResult.ok).toBe(true);
        if (jsonResult.ok) {
          expect(JSON.parse(jsonResult.value)).toEqual({ value: expected });
        }
      }
    },
  );

  it("rejects empty and over-limit JSON input", () => {
    expectFailure(jsonToYaml(""), "syntax");
    expectFailure(
      jsonToYaml(`"${"中".repeat(MAX_YAML_JSON_INPUT_BYTES)}"`),
      "input-limit",
    );
  });
});

describe("transformYamlJson", () => {
  it("dispatches both directions and honours the JSON indent option", () => {
    const json = transformYamlJson("name: 工具", "yaml-to-json", {
      jsonIndent: 4,
    });
    expect(json.ok && json.value).toContain('    "name": "工具"');

    const yaml = transformYamlJson('{"name":"工具"}', "json-to-yaml");
    expect(yaml).toEqual({ ok: true, value: "name: 工具\n" });
  });
});

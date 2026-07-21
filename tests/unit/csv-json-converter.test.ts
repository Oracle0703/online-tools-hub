import { describe, expect, it, vi } from "vitest";

import {
  csvToJson,
  jsonToCsv,
  MAX_CSV_JSON_CELLS,
  MAX_CSV_JSON_INPUT_BYTES,
  MAX_CSV_JSON_NESTING_DEPTH,
  MAX_CSV_JSON_NODES,
  MAX_CSV_JSON_NUMBER_CHARACTERS,
  MAX_CSV_JSON_OUTPUT_BYTES,
  MAX_CSV_JSON_ROWS,
  transformCsvJson,
  type CsvJsonTransformResult,
} from "../../src/tools/csv-json-converter";

function expectFailure(result: CsvJsonTransformResult, kind: string) {
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error.kind).toBe(kind);
    expect(result.error.line).toBeGreaterThanOrEqual(1);
    expect(result.error.column).toBeGreaterThanOrEqual(1);
    expect(result.error.pointer).toContain("^");
  }
}

describe("csvToJson", () => {
  it("auto-detects comma CSV and preserves every cell as a string", () => {
    const result = csvToJson("id,name,active,amount\n001,小明,true,12.50");

    expect(result).toMatchObject({
      ok: true,
      delimiter: ",",
      rows: 1,
      columns: 4,
    });
    if (result.ok) {
      expect(JSON.parse(result.value)).toEqual([
        { id: "001", name: "小明", active: "true", amount: "12.50" },
      ]);
    }
  });

  it("supports UTF-8 BOM, CRLF, escaped quotes and newlines inside quoted cells", () => {
    const result = csvToJson(
      '\uFEFFname,note\r\n小明,"第一行\r\n第二行"\r\n小红,"他说""你好"""\r\n',
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(JSON.parse(result.value)).toEqual([
        { name: "小明", note: "第一行\r\n第二行" },
        { name: "小红", note: '他说"你好"' },
      ]);
    }
  });

  it.each([
    ["name;city\n小明;上海", ";"],
    ["name\tcity\n小明\t上海", "\t"],
  ] as const)(
    "safely auto-detects supported delimiters",
    (input, delimiter) => {
      const result = csvToJson(input);
      expect(result).toMatchObject({ ok: true, delimiter });
    },
  );

  it("requires an explicit choice when auto-detection is ambiguous", () => {
    const source = "left,right;note\n1,2;ok";
    const automatic = csvToJson(source);
    expectFailure(automatic, "delimiter-detection");
    if (!automatic.ok) expect(automatic.error.message).toContain("多个");

    const explicit = csvToJson(source, { delimiter: "," });
    expect(explicit.ok).toBe(true);
    if (explicit.ok) {
      expect(JSON.parse(explicit.value)).toEqual([
        { left: "1", "right;note": "2;ok" },
      ]);
    }

    expectFailure(csvToJson("a,b;c\td\n1,2;3\t4"), "delimiter-detection");
  });

  it("supports a single column when its delimiter is selected explicitly", () => {
    const result = csvToJson("value\n001\ntrue", { delimiter: "," });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(JSON.parse(result.value)).toEqual([
        { value: "001" },
        { value: "true" },
      ]);
    }
  });

  it("supports four-space JSON indentation", () => {
    const result = csvToJson("name,city\n小明,上海", {
      delimiter: ",",
      jsonIndent: 4,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toContain('\n        "name"');
  });

  it.each([
    [",name\n1,小明", "empty-header"],
    ["name,name\n小明,上海", "duplicate-header"],
    ["name,city\n小明", "column-mismatch"],
    ["name,city\n小明,上海,多余", "column-mismatch"],
  ])("reports invalid table shape for %s", (input, kind) => {
    const result = csvToJson(input);
    expectFailure(result, kind);
  });

  it("reports a precise row boundary for mismatched columns", () => {
    const result = csvToJson("name,city\r\n小明,上海\r\n小红", {
      delimiter: ",",
    });
    expectFailure(result, "column-mismatch");
    if (!result.ok) expect(result.error).toMatchObject({ line: 3, column: 1 });
  });

  it.each([
    ['name,note\n小明,"未结束', "没有结束引号"],
    ['name,note\n小明,前缀"错误', "单元格开头"],
    ['name,note\n小明,"完成"多余', "结束引号后"],
  ])("rejects malformed quoted fields: %s", (input, message) => {
    const result = csvToJson(input, { delimiter: "," });
    expectFailure(result, "syntax");
    if (!result.ok) expect(result.error.message).toContain(message);
  });

  it("keeps __proto__ as ordinary data without prototype pollution", () => {
    const result = csvToJson("__proto__,value\nsafe,1", { delimiter: "," });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const value = JSON.parse(result.value) as Array<Record<string, string>>;
      expect(value[0]?.__proto__).toBe("safe");
      expect(({} as Record<string, unknown>).value).toBeUndefined();
    }
  });

  it("rejects blank, undetectable and over-limit input", () => {
    expectFailure(csvToJson("\uFEFF \r\n"), "syntax");
    expectFailure(csvToJson("one column\nvalue"), "delimiter-detection");
    expectFailure(
      csvToJson(`name,value\n${"x".repeat(MAX_CSV_JSON_INPUT_BYTES)}`, {
        delimiter: ",",
      }),
      "input-limit",
    );
  });

  it("rejects a row before appending it beyond the hard row limit", () => {
    const input = `header\n${"value\n".repeat(MAX_CSV_JSON_ROWS)}`;
    const result = csvToJson(input, { delimiter: "," });

    expectFailure(result, "row-limit");
    if (!result.ok) expect(result.error.message).toContain("100,000");
  });

  it("rejects a field before appending it beyond the hard cell limit", () => {
    const input = `${",".repeat(MAX_CSV_JSON_CELLS)}value`;
    const result = csvToJson(input, { delimiter: "," });

    expectFailure(result, "cell-limit");
    if (!result.ok) expect(result.error.message).toContain("500,000");
  });

  it("stops JSON output while appending at the 16 MiB byte limit", () => {
    const header = "h".repeat(2_000);
    const input = `${header}\n${"x\n".repeat(9_000)}`;
    const result = csvToJson(input, { delimiter: "," });

    expect(MAX_CSV_JSON_OUTPUT_BYTES).toBe(16 * 1024 * 1024);
    expectFailure(result, "output-limit");
    if (!result.ok) expect(result.error.message).toContain("16 MiB");
  });
});

describe("jsonToCsv", () => {
  it("converts a flat object array and quotes delimiters, quotes and newlines", () => {
    const result = jsonToCsv(
      JSON.stringify([
        { name: "小明", note: '你好, "世界"', detail: "第一行\n第二行" },
        { name: "小红", note: "安全", detail: "单行" },
      ]),
    );

    expect(result).toMatchObject({
      ok: true,
      delimiter: ",",
      rows: 2,
      columns: 3,
    });
    if (result.ok) {
      expect(result.value).toBe(
        'name,note,detail\r\n小明,"你好, ""世界""","第一行\n第二行"\r\n小红,安全,单行',
      );
    }
  });

  it("uses the union of headers and supports primitive cells", () => {
    const result = jsonToCsv(
      '[{"name":"小明","active":true,"score":125,"note":null},{"name":"小红","city":"上海"}]',
      { delimiter: ";" },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(
        "name;active;score;note;city\r\n小明;true;125;;\r\n小红;;;;上海",
      );
    }
  });

  it("supports tab-separated output and a stable transform dispatcher", () => {
    const tab = jsonToCsv('[{"name":"小明","city":"上海"}]', {
      delimiter: "\t",
    });
    expect(tab).toMatchObject({ ok: true, delimiter: "\t" });
    if (tab.ok) expect(tab.value).toBe("name\tcity\r\n小明\t上海");

    const dispatched = transformCsvJson(
      '[{"name":"小明","city":"上海"}]',
      "json-to-csv",
      { delimiter: "auto" },
    );
    expect(dispatched).toMatchObject({ ok: true, delimiter: "," });
  });

  it.each([
    ["{}", "unsupported-structure"],
    ["[]", "unsupported-structure"],
    ["[1]", "unsupported-structure"],
    ["[null]", "unsupported-structure"],
    ["[{}]", "empty-header"],
    ['[{"": "value"}]', "empty-header"],
    ['[{"name":"小明","meta":{"city":"上海"}}]', "unsupported-structure"],
    ['[{"name":"小明","tags":["本地"]}]', "unsupported-structure"],
  ])("rejects unsupported JSON table structure: %s", (input, kind) => {
    expectFailure(jsonToCsv(input), kind);
  });

  it("rejects duplicate JSON object keys before JSON.parse can overwrite them", () => {
    const result = jsonToCsv('[{"name":"first","name":"second"}]');
    expectFailure(result, "duplicate-header");
    if (!result.ok) {
      expect(result.error.message).toContain("重复");
      expect(result.error.column).toBeGreaterThan(10);
    }
  });

  it("reports JSON syntax errors with line and Unicode-aware column", () => {
    const result = jsonToCsv('[\n  {"😀": "ok", "broken": nope}\n]');
    expectFailure(result, "syntax");
    if (!result.ok) {
      expect(result.error.line).toBe(2);
      expect(result.error.context).toContain("broken");
    }
  });

  it.each([
    "9007199254740993",
    "9007199254740993e0",
    "1000000000000000100",
    "1.0000000000000001",
    "0.10000000000000001",
    "4e-324",
    "1e400",
  ])("rejects JSON numbers that would silently change: %s", (number) => {
    const result = jsonToCsv(`[{"value":${number}}]`);
    expectFailure(result, "unsafe-number");
  });

  it.each([
    ["9007199254740992", "9007199254740992"],
    ["9007199254740992e0", "9007199254740992"],
    ["1e21", "1e+21"],
    ["1.0000000000000000", "1"],
    ["0.1", "0.1"],
    ["1.25e2", "125"],
    ["5e-324", "5e-324"],
    ["-0", "-0"],
    ["-0.0", "-0"],
  ])("accepts stable JSON number %s", (number, output) => {
    const result = jsonToCsv(`[{"value":${number}}]`);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(`value\r\n${output}`);
  });

  it("rejects excessive nesting and over-limit input", () => {
    const nested = `${"[".repeat(MAX_CSV_JSON_NESTING_DEPTH + 1)}0${"]".repeat(MAX_CSV_JSON_NESTING_DEPTH + 1)}`;
    expectFailure(jsonToCsv(nested), "unsupported-structure");
    expectFailure(
      jsonToCsv(`[{"value":"${"x".repeat(MAX_CSV_JSON_INPUT_BYTES)}"}]`),
      "input-limit",
    );
  });

  it("bounds extremely long JSON number tokens before numeric conversion", () => {
    const result = jsonToCsv(
      `[{"value":${"9".repeat(MAX_CSV_JSON_NUMBER_CHARACTERS + 1)}}]`,
    );
    expectFailure(result, "unsafe-number");
    if (!result.ok) expect(result.error.message).toContain("字符");
  });

  it("bounds the rectangular CSV result before allocating an output matrix", () => {
    const headers = Object.fromEntries(
      Array.from({ length: 500 }, (_, index) => [`field_${index}`, "value"]),
    );
    const input = JSON.stringify([
      headers,
      ...Array.from({ length: 999 }, () => ({})),
    ]);
    const result = jsonToCsv(input);

    expect(MAX_CSV_JSON_ROWS).toBe(100_000);
    expect(MAX_CSV_JSON_CELLS).toBe(500_000);
    expectFailure(result, "cell-limit");
  });

  it("rejects oversized flat JSON before calling JSON.parse", () => {
    const input = `[${"0,".repeat(MAX_CSV_JSON_NODES)}0]`;
    const parseSpy = vi.spyOn(JSON, "parse");

    try {
      const result = jsonToCsv(input);
      expectFailure(result, "node-limit");
      expect(parseSpy).not.toHaveBeenCalled();
    } finally {
      parseSpy.mockRestore();
    }
  });
});

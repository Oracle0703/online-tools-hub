import { describe, expect, it } from "vitest";

import {
  buildQueryString,
  exportQueryParametersJson,
  MAX_QUERY_INPUT_BYTES,
  parseQueryInput,
  rebuildQueryInput,
  sortQueryParameters,
  type QueryParameter,
} from "../../src/tools/query-params";

describe("parseQueryInput", () => {
  it("parses a full URL while preserving the base, fragment, order and duplicates", () => {
    expect(
      parseQueryInput(
        "https://example.com/search?tag=web&tag=tools&empty=&flag#results",
      ),
    ).toEqual({
      ok: true,
      value: {
        sourceKind: "url",
        base: "https://example.com/search",
        fragment: "#results",
        hadQueryMarker: true,
        parameters: [
          { key: "tag", value: "web", hasEquals: true },
          { key: "tag", value: "tools", hasEquals: true },
          { key: "empty", value: "", hasEquals: true },
          { key: "flag", value: "", hasEquals: false },
        ],
      },
    });
  });

  it.each([
    ["?a=1&b=2", "query", true],
    ["a=1&b=2", "bare", false],
    ["https://example.com/path", "url", false],
    ["//example.com/path", "url", false],
  ] as const)("recognizes %j as %s", (input, sourceKind, hadQueryMarker) => {
    const result = parseQueryInput(input);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toMatchObject({ sourceKind, hadQueryMarker });
    }
  });

  it.each([
    ["?=", [{ key: "", value: "", hasEquals: true }]],
    ["?flag", [{ key: "flag", value: "", hasEquals: false }]],
    [
      "?&",
      [
        { key: "", value: "", hasEquals: false },
        { key: "", value: "", hasEquals: false },
      ],
    ],
    [
      "?a&&b=",
      [
        { key: "a", value: "", hasEquals: false },
        { key: "", value: "", hasEquals: false },
        { key: "b", value: "", hasEquals: true },
      ],
    ],
    ["?", []],
  ] as const)(
    "preserves empty and no-equals semantics for %j",
    (input, expected) => {
      const result = parseQueryInput(input);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.parameters).toEqual(expected);
    },
  );

  it("supports RFC percent decoding while retaining literal plus signs", () => {
    const result = parseQueryInput("?q=%E4%B8%AD%E6%96%87%20tools&plus=a+b", {
      encoding: "rfc3986",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.parameters).toEqual([
        { key: "q", value: "中文 tools", hasEquals: true },
        { key: "plus", value: "a+b", hasEquals: true },
      ]);
    }
  });

  it.each([
    ["?value=%C3%A9", "é"],
    ["?value=%F0%9F%98%80", "😀"],
    ["?value=plain%20%E4%B8%AD", "plain 中"],
  ] as const)("decodes valid UTF-8 sequence in %j", (input, expected) => {
    const result = parseQueryInput(input);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.parameters[0]?.value).toBe(expected);
  });

  it("supports form decoding where plus signs represent spaces", () => {
    const result = parseQueryInput("?q=%E4%B8%AD%E6%96%87+tools&plus=a%2Bb", {
      encoding: "form",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.parameters).toEqual([
        { key: "q", value: "中文 tools", hasEquals: true },
        { key: "plus", value: "a+b", hasEquals: true },
      ]);
    }
  });

  it.each([
    ["?ok=1&bad=%", 10, 1, 11, "invalid-percent-escape"],
    ["?ok=1&bad=%2", 10, 1, 11, "invalid-percent-escape"],
    ["?ok=1&bad=%GG", 10, 1, 11, "invalid-percent-escape"],
    ["?ok=1&bad=%C0%AF", 10, 1, 11, "invalid-utf8"],
    ["?ok=1&bad=%E4%B8", 10, 1, 11, "invalid-utf8"],
    ["?ok=1&\nbad=%GG", 11, 2, 5, "invalid-percent-escape"],
  ] as const)(
    "reports strict decoding error for %j",
    (input, offset, line, column, code) => {
      const result = parseQueryInput(input);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatchObject({
          offset,
          line,
          column,
          code,
          parameterIndex: 2,
        });
        expect(result.error.pointer).toContain("^");
      }
    },
  );

  it.each([
    "%20%G0",
    "%C2",
    "%E0%80%80",
    "%ED%A0%80",
    "%E1%80",
    "%F0%80%80%80",
    "%F4%90%80%80",
    "%F1%80%80",
    "%80",
    "%F5%80%80%80",
  ])("rejects malformed byte boundary %j", (value) => {
    const result = parseQueryInput(`?value=${value}`);
    expect(result.ok).toBe(false);
  });

  it("rejects unpaired literal surrogates but accepts a valid pair", () => {
    const high = parseQueryInput("?value=\ud800");
    expect(high.ok).toBe(false);
    if (!high.ok) expect(high.error.code).toBe("invalid-unicode");

    const low = parseQueryInput("?value=\udfff");
    expect(low.ok).toBe(false);
    if (!low.ok) expect(low.error.code).toBe("invalid-unicode");

    const pair = parseQueryInput("?value=😀");
    expect(pair.ok).toBe(true);
  });

  it("caps the number of structured parameters", () => {
    const input = Array.from({ length: 10_001 }, () => "x").join("&");
    const result = parseQueryInput(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject({
        code: "too-many-parameters",
        parameterIndex: 10_001,
      });
    }
  });

  it("keeps error context bounded for a long query", () => {
    const input = `?${"a".repeat(80)}=%GG&${"b".repeat(80)}`;
    const result = parseQueryInput(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.context.startsWith("…")).toBe(true);
      expect(result.error.context.endsWith("…")).toBe(true);
      expect(result.error.column).toBe(83);
    }
  });

  it("rejects input above the 2 MiB boundary", () => {
    const result = parseQueryInput(`q=${"a".repeat(MAX_QUERY_INPUT_BYTES)}`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("input-too-large");
  });
});

describe("query building", () => {
  const parameters: QueryParameter[] = [
    { key: "q", value: "中文 tools", hasEquals: true },
    { key: "plus", value: "a+b", hasEquals: true },
    { key: "empty", value: "", hasEquals: true },
    { key: "flag", value: "ignored", hasEquals: false },
    { key: "", value: "", hasEquals: false },
  ];

  it("uses strict RFC 3986 percent encoding", () => {
    expect(
      buildQueryString(
        [...parameters, { key: "reserved", value: "!'()*", hasEquals: true }],
        { encoding: "rfc3986" },
      ),
    ).toEqual({
      ok: true,
      value:
        "q=%E4%B8%AD%E6%96%87%20tools&plus=a%2Bb&empty=&flag&&reserved=%21%27%28%29%2A",
    });
  });

  it("uses form plus-space encoding without losing literal plus signs", () => {
    expect(buildQueryString(parameters, { encoding: "form" })).toEqual({
      ok: true,
      value: "q=%E4%B8%AD%E6%96%87+tools&plus=a%2Bb&empty=&flag&",
    });
  });

  it("rebuilds full URLs, leading-query input and bare input", () => {
    expect(
      rebuildQueryInput(
        {
          sourceKind: "url",
          base: "https://example.com/search",
          fragment: "#top",
          hadQueryMarker: true,
        },
        parameters.slice(0, 2),
      ),
    ).toEqual({
      ok: true,
      value:
        "https://example.com/search?q=%E4%B8%AD%E6%96%87%20tools&plus=a%2Bb#top",
    });
    expect(
      rebuildQueryInput(
        {
          sourceKind: "query",
          base: "",
          fragment: "#top",
          hadQueryMarker: true,
        },
        [],
      ),
    ).toEqual({ ok: true, value: "?#top" });
    expect(
      rebuildQueryInput(
        { sourceKind: "bare", base: "", fragment: "", hadQueryMarker: false },
        parameters.slice(2, 4),
      ),
    ).toEqual({ ok: true, value: "empty=&flag" });
  });

  it("does not invent a query marker for an empty URL without one", () => {
    expect(
      rebuildQueryInput(
        {
          sourceKind: "url",
          base: "https://example.com/",
          fragment: "#top",
          hadQueryMarker: false,
        },
        [],
      ),
    ).toEqual({ ok: true, value: "https://example.com/#top" });
  });

  it("rejects unpaired surrogates without throwing", () => {
    const result = buildQueryString([
      { key: "broken\ud800", value: "", hasEquals: true },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject({
        code: "invalid-unicode",
        parameterIndex: 1,
      });
    }

    const valueResult = buildQueryString([
      { key: "valid", value: "broken\udfff", hasEquals: true },
    ]);
    expect(valueResult.ok).toBe(false);

    const rebuiltResult = rebuildQueryInput(
      {
        sourceKind: "query",
        base: "",
        fragment: "",
        hadQueryMarker: true,
      },
      [{ key: "broken\ud800", value: "", hasEquals: false }],
    );
    expect(rebuiltResult.ok).toBe(false);
  });
});

describe("structured operations", () => {
  it("sorts explicitly by decoded key and keeps duplicates stable", () => {
    const source = [
      { key: "z", value: "last", hasEquals: true, id: "1" },
      { key: "a", value: "first", hasEquals: true, id: "2" },
      { key: "a", value: "second", hasEquals: true, id: "3" },
      { key: "m", value: "middle", hasEquals: true, id: "4" },
    ];

    const sorted = sortQueryParameters(source);
    expect(sorted.map(({ id }) => id)).toEqual(["2", "3", "4", "1"]);
    expect(source.map(({ id }) => id)).toEqual(["1", "2", "3", "4"]);
  });

  it("exports order and the no-equals distinction to JSON", () => {
    const json = exportQueryParametersJson(
      { sourceKind: "url", base: "https://x.test", fragment: "#top" },
      [
        { key: "flag", value: "", hasEquals: false },
        { key: "empty", value: "", hasEquals: true },
      ],
      "form",
    );

    expect(JSON.parse(json)).toEqual({
      source: { kind: "url", base: "https://x.test", fragment: "#top" },
      encoding: "form",
      parameters: [
        { key: "flag", value: null, hasEquals: false },
        { key: "empty", value: "", hasEquals: true },
      ],
    });
  });
});

import { describe, expect, it } from "vitest";

import { encodeBase64 } from "../../src/tools/base64-codec";
import {
  decodeJwt,
  MAX_JWT_BYTES,
  MAX_JWT_JSON_DEPTH,
  MAX_JWT_JSON_NODES,
  MAX_JWT_JSON_NUMBER_CHARS,
} from "../../src/tools/jwt-decoder";

function tokenFor(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  signature = encodeBase64("signature", "url"),
): string {
  return `${encodeBase64(JSON.stringify(header), "url")}.${encodeBase64(JSON.stringify(payload), "url")}.${signature}`;
}

function tokenFromJson(
  payloadJson: string,
  headerJson = '{"alg":"HS256","typ":"JWT"}',
  signature = "c2ln",
): string {
  return `${encodeBase64(headerJson, "url")}.${encodeBase64(payloadJson, "url")}.${signature}`;
}

describe("JWT 本地解析核心", () => {
  it("严格解码 Header、Payload 并解释时间声明", () => {
    const now = Date.UTC(2026, 0, 1);
    const result = decodeJwt(
      tokenFor(
        { alg: "HS256", typ: "JWT" },
        {
          sub: "用户-🙂",
          iat: now / 1000 - 60,
          nbf: now / 1000 - 30,
          exp: now / 1000 + 3600,
        },
      ),
      now,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.header).toEqual({ alg: "HS256", typ: "JWT" });
    expect(result.value.payload.sub).toBe("用户-🙂");
    expect(result.value.algorithm).toBe("HS256");
    expect(result.value.tokenType).toBe("JWT");
    expect(result.value.isUnsigned).toBe(false);
    expect(
      result.value.timeClaims.map(({ claim, state }) => [claim, state]),
    ).toEqual([
      ["exp", "valid"],
      ["nbf", "active"],
      ["iat", "past"],
    ]);
  });

  it("将过期、尚未生效和未来签发时间标为警告状态", () => {
    const now = Date.UTC(2026, 6, 20);
    const result = decodeJwt(
      tokenFor(
        { alg: "RS256" },
        {
          exp: now / 1000 - 1,
          nbf: now / 1000 + 60,
          iat: now / 1000 + 30,
        },
      ),
      now,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.timeClaims.map(({ state }) => state)).toEqual([
      "expired",
      "pending",
      "future",
    ]);
  });

  it("在 NumericDate 临界时刻采用 exp 失效、nbf 生效和 iat 不晚于当前时间语义", () => {
    const now = Date.UTC(2026, 6, 20, 12, 0, 0);
    const result = decodeJwt(
      tokenFor(
        { alg: "ES256" },
        { exp: now / 1000, nbf: now / 1000, iat: now / 1000 },
      ),
      now,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.timeClaims.map(({ state }) => state)).toEqual([
      "expired",
      "active",
      "past",
    ]);
  });

  it("接受 Date 的正负极限，并拒绝刚刚越界的 NumericDate", () => {
    const maximumDateSeconds = 8_640_000_000_000;
    const result = decodeJwt(
      tokenFor(
        { alg: "HS256" },
        {
          exp: maximumDateSeconds,
          nbf: maximumDateSeconds + 1,
          iat: -maximumDateSeconds,
        },
      ),
      0,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.timeClaims).toMatchObject([
      { claim: "exp", state: "valid", iso: "+275760-09-13T00:00:00.000Z" },
      { claim: "nbf", state: "invalid-date", iso: null },
      { claim: "iat", state: "past", iso: "-271821-04-20T00:00:00.000Z" },
    ]);
  });

  it("识别空签名和 alg=none，但仍只返回解析结果", () => {
    const result = decodeJwt(tokenFor({ alg: "none" }, { sub: "demo" }, ""));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.isUnsigned).toBe(true);
    expect(result.value.signature).toBe("");
  });

  it("保留规范签名输入，并允许语法上有效的空 Signature", () => {
    const token = tokenFor({ alg: "HS256" }, { sub: "demo" }, "");
    const result = decodeJwt(`\n ${token} \t`);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.token).toBe(token);
    expect(result.value.signingInput).toBe(
      token.slice(0, token.lastIndexOf(".")),
    );
    expect(result.value.isUnsigned).toBe(true);
  });

  it.each([
    ["", "EMPTY"],
    ["only.two", "INVALID_COMPACT_FORMAT"],
    ["too.many.parts.here", "INVALID_COMPACT_FORMAT"],
    ["with white.space.parts", "INVALID_COMPACT_FORMAT"],
  ])("拒绝无效紧凑格式 %j", (input, code) => {
    const result = decodeJwt(input);
    expect(result).toMatchObject({ ok: false, error: { code } });
  });

  it("拒绝不是规范 Base64URL 的 Header", () => {
    const payload = encodeBase64(JSON.stringify({ sub: "demo" }), "url");
    const result = decodeJwt(`***.${payload}.c2ln`);

    expect(result).toMatchObject({
      ok: false,
      error: { code: "INVALID_SEGMENT", segment: "header" },
    });
  });

  it("拒绝 Header 或 Payload 中带等号填充的 Base64URL", () => {
    const header = encodeBase64(JSON.stringify({ alg: "HS256" }), "url");
    const payload = encodeBase64(JSON.stringify({ sub: "demo" }), "url");

    expect(decodeJwt(`e30=.${payload}.c2ln`)).toMatchObject({
      ok: false,
      error: { code: "INVALID_SEGMENT", segment: "header" },
    });
    expect(decodeJwt(`${header}.e30=.c2ln`)).toMatchObject({
      ok: false,
      error: { code: "INVALID_SEGMENT", segment: "payload" },
    });
  });

  it("拒绝 Base64URL 解码后不是有效 UTF-8 的段", () => {
    const header = encodeBase64(JSON.stringify({ alg: "HS256" }), "url");
    const result = decodeJwt(`${header}._w.c2ln`);

    expect(result).toMatchObject({
      ok: false,
      error: { code: "INVALID_SEGMENT", segment: "payload" },
    });
  });

  it("拒绝无效 JSON，以及非对象 Header 或 Payload", () => {
    const header = encodeBase64(JSON.stringify({ alg: "HS256" }), "url");
    const broken = encodeBase64("{broken", "url");
    const array = encodeBase64("[]", "url");

    expect(decodeJwt(`${header}.${broken}.c2ln`)).toMatchObject({
      ok: false,
      error: { code: "INVALID_JSON", segment: "payload" },
    });
    expect(decodeJwt(`${header}.${array}.c2ln`)).toMatchObject({
      ok: false,
      error: { code: "INVALID_JSON_OBJECT", segment: "payload" },
    });
    expect(decodeJwt(`${array}.e30.c2ln`)).toMatchObject({
      ok: false,
      error: { code: "INVALID_JSON_OBJECT", segment: "header" },
    });
  });

  it("拒绝非规范 Signature 长度和填充位", () => {
    const base = tokenFor({ alg: "HS256" }, { sub: "demo" }).split(".");
    expect(decodeJwt(`${base[0]}.${base[1]}.A`)).toMatchObject({
      ok: false,
      error: { code: "INVALID_SEGMENT", segment: "signature" },
    });
    expect(decodeJwt(`${base[0]}.${base[1]}.AB`)).toMatchObject({
      ok: false,
      error: { code: "INVALID_SEGMENT", segment: "signature" },
    });
    expect(decodeJwt(`${base[0]}.${base[1]}.c2ln=`)).toMatchObject({
      ok: false,
      error: { code: "INVALID_SEGMENT", segment: "signature" },
    });
    expect(decodeJwt(`${base[0]}.${base[1]}.AA`)).toMatchObject({ ok: true });
  });

  it("明确报告非数值时间字段和不可表示的数值日期", () => {
    const result = decodeJwt(
      tokenFor(
        { alg: "HS256" },
        { exp: 8_640_000_000_001, nbf: "tomorrow", iat: null },
      ),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.timeClaims).toMatchObject([
      {
        claim: "exp",
        seconds: 8_640_000_000_001,
        state: "invalid-date",
        iso: null,
      },
      { claim: "nbf", seconds: null, state: "invalid-type", iso: null },
      { claim: "iat", seconds: null, state: "invalid-type", iso: null },
    ]);
  });

  it.each([
    ["9007199254740993", "超出 JavaScript 安全整数范围"],
    ["-9007199254740993", "超出 JavaScript 安全整数范围"],
    ["1e400", "溢出为非有限值"],
    ["1e-400", "下溢为 0"],
    ["0.10000000000000001", "解析后会被改写为 0.1"],
    ["1.0000000000000001", "解析后会被改写为 1"],
    ["4e-324", "解析后会被改写为 5e-324"],
  ])("在 JSON.parse 改值前拒绝不安全数字 %s", (literal, message) => {
    const result = decodeJwt(tokenFromJson(`{"value":${literal}}`));

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "UNSAFE_JSON_NUMBER",
        segment: "payload",
        message: expect.stringContaining(message),
      },
    });
  });

  it("保留安全整数以及十进制值可稳定往返的小数和指数", () => {
    const result = decodeJwt(
      tokenFromJson(
        '{"maximumSafe":9007199254740991,"fraction":1.5,"commonDecimal":0.1,"numericDate":1767225600.1,"exponent":1e3,"negativeZero":-0.0}',
      ),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.payload).toMatchObject({
      maximumSafe: Number.MAX_SAFE_INTEGER,
      fraction: 1.5,
      commonDecimal: 0.1,
      numericDate: 1_767_225_600.1,
      exponent: 1000,
    });
    expect(Object.is(result.value.payload.negativeZero, -0)).toBe(true);
  });

  it("拒绝异常长的数字字面量", () => {
    const literal = `0.${"0".repeat(MAX_JWT_JSON_NUMBER_CHARS)}1`;
    const result = decodeJwt(tokenFromJson(`{"value":${literal}}`));

    expect(result).toMatchObject({
      ok: false,
      error: { code: "UNSAFE_JSON_NUMBER", segment: "payload" },
    });
  });

  it("在 JSON.parse 和 UI 序列化前拒绝过深结构", () => {
    const allowedJson =
      '{"value":'.repeat(MAX_JWT_JSON_DEPTH) +
      "null" +
      "}".repeat(MAX_JWT_JSON_DEPTH);
    const tooDeepJson =
      '{"value":'.repeat(MAX_JWT_JSON_DEPTH + 1) +
      "null" +
      "}".repeat(MAX_JWT_JSON_DEPTH + 1);

    expect(decodeJwt(tokenFromJson(allowedJson))).toMatchObject({ ok: true });
    expect(decodeJwt(tokenFromJson(tooDeepJson))).toMatchObject({
      ok: false,
      error: {
        code: "JSON_STRUCTURE_LIMIT",
        segment: "payload",
        message: expect.stringContaining(`${MAX_JWT_JSON_DEPTH} 层`),
      },
    });
  });

  it("用迭代遍历拒绝节点数过多的宽结构", () => {
    const payload = JSON.stringify({
      values: Array.from({ length: MAX_JWT_JSON_NODES }, () => null),
    });
    const result = decodeJwt(tokenFromJson(payload));

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "JSON_STRUCTURE_LIMIT",
        segment: "payload",
        message: expect.stringContaining("10,000 个节点"),
      },
    });
  });

  it("结构与数字扫描会忽略 JSON 字符串内部的符号", () => {
    const payload = JSON.stringify({
      braces: "[".repeat(MAX_JWT_JSON_DEPTH + 10),
      numberText: "9007199254740993 and 0.1",
    });

    expect(decodeJwt(tokenFromJson(payload))).toMatchObject({ ok: true });
  });

  it("在解析前拒绝超过 256 KiB 的 Token", () => {
    const result = decodeJwt("a".repeat(MAX_JWT_BYTES + 1));
    expect(result).toMatchObject({ ok: false, error: { code: "TOO_LARGE" } });
  });

  it("按原始输入字节计算上限，不能用首尾空白绕过限制", () => {
    const token = tokenFor({ alg: "HS256" }, { sub: "demo" });
    const padding = " ".repeat(MAX_JWT_BYTES - token.length + 1);

    expect(decodeJwt(`${padding}${token}`)).toMatchObject({
      ok: false,
      error: { code: "TOO_LARGE" },
    });
  });
});

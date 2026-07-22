import { describe, expect, it } from "vitest";

import {
  calculateQrScanDimensions,
  getQrTextByteLength,
  isQrCodeResult,
  isQrWorkerExecuteMessage,
  isQrWorkerResultMessage,
  QR_CODE_LIMITS,
  QR_WORKER_PROTOCOL_VERSION,
  type QrGenerateSuccess,
  type QrScanSuccess,
} from "../../src/tools/qr-code/contract";

const validSvg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 29 29" shape-rendering="crispEdges"><rect width="29" height="29" fill="#ffffff"/><path d="M0,0h1v1h-1zM28,28h1v1h-1z" fill="#0f172a"/></svg>';

const validGenerate: QrGenerateSuccess = {
  ok: true,
  mode: "generate",
  svg: validSvg,
  version: 1,
  modules: 29,
  ecc: "M",
  displaySize: 256,
  textBytes: 5,
  outputBytes: getQrTextByteLength(validSvg),
};

const validScan: QrScanSuccess = {
  ok: true,
  mode: "scan",
  text: "二维码🙂",
  textBytes: getQrTextByteLength("二维码🙂"),
  version: 1,
};

function resultMessage(result: unknown = validGenerate) {
  return {
    type: "QR_CODE_RESULT",
    protocol: QR_WORKER_PROTOCOL_VERSION,
    taskId: "qr-contract-task",
    result,
  };
}

function generateRequest(input: unknown = undefined) {
  return {
    type: "QR_CODE_EXECUTE",
    protocol: QR_WORKER_PROTOCOL_VERSION,
    taskId: "qr-contract-task",
    input:
      input ??
      ({
        mode: "generate",
        text: "hello",
        ecc: "M",
        displaySize: 256,
      } as const),
  };
}

function scanRequest(input: unknown = undefined) {
  return generateRequest(
    input ?? {
      mode: "scan",
      rgba: new ArrayBuffer(16),
      width: 2,
      height: 2,
      inversionAttempts: "attemptBoth",
    },
  );
}

describe("QR contract dimension calculation", () => {
  it.each([
    [0, 1],
    [1, 0],
    [-1, 1],
    [1, -1],
    [1.5, 1],
    [1, 1.5],
    [Number.NaN, 1],
    [1, Number.POSITIVE_INFINITY],
  ])("rejects invalid dimensions %s × %s", (width, height) => {
    expect(calculateQrScanDimensions(width, height)).toEqual({
      width: 0,
      height: 0,
      resized: false,
    });
  });

  it("keeps images at or below 4 MP and downscales either orientation", () => {
    expect(calculateQrScanDimensions(2000, 2000)).toEqual({
      width: 2000,
      height: 2000,
      resized: false,
    });

    for (const [width, height] of [
      [4000, 2000],
      [2000, 4000],
      [8192, 1],
      [1, 8192],
    ] as const) {
      const result = calculateQrScanDimensions(width, height);
      expect(result.resized).toBe(
        width * height > QR_CODE_LIMITS.maxScanPixels,
      );
      expect(result.width).toBeGreaterThan(0);
      expect(result.height).toBeGreaterThan(0);
      expect(result.width * result.height).toBeLessThanOrEqual(
        QR_CODE_LIMITS.maxScanPixels,
      );
      expect(result.width / result.height).toBeCloseTo(width / height, 2);
    }
  });
});

describe("QR result validation", () => {
  it("accepts exact success and failure records", () => {
    expect(isQrCodeResult(validGenerate)).toBe(true);
    expect(isQrCodeResult(validScan)).toBe(true);
    expect(
      isQrCodeResult({
        ok: false,
        error: {
          code: "capacity-exceeded",
          message: "fixed safe error",
          field: "text",
          actual: 10,
          limit: 5,
        },
      }),
    ).toBe(true);
  });

  it.each([
    null,
    [],
    { ok: "true" },
    { ok: true, mode: "other" },
    { ok: false },
    { ok: false, error: null },
    { ok: false, error: { code: "unknown", message: "safe" } },
    { ok: false, error: { code: "not-found", message: "" } },
    { ok: false, error: { code: "not-found", message: "x".repeat(257) } },
    {
      ok: false,
      error: { code: "not-found", message: "safe", field: "unknown" },
    },
    {
      ok: false,
      error: { code: "not-found", message: "safe", actual: -1 },
    },
    {
      ok: false,
      error: {
        code: "not-found",
        message: "safe",
        limit: Number.MAX_SAFE_INTEGER + 1,
      },
    },
    {
      ok: false,
      error: { code: "not-found", message: "safe", extra: true },
    },
  ])("rejects malformed general/failure result %#", (candidate) => {
    expect(isQrCodeResult(candidate)).toBe(false);
  });

  it.each([
    { extra: true },
    { svg: 1 },
    { version: 0 },
    { version: 41 },
    { modules: 28 },
    { modules: 186 },
    { ecc: "X" },
    { displaySize: 257 },
    { textBytes: -1 },
    { textBytes: QR_CODE_LIMITS.maxTextBytes + 1 },
    { outputBytes: -1 },
    { outputBytes: QR_CODE_LIMITS.maxSvgBytes + 1 },
    { outputBytes: 0 },
    { svg: validSvg.replace("<svg", "<xsvg") },
    { svg: validSvg.replace("</svg>", "</svg><extra>") },
    { svg: validSvg.replace("M0,0h1v1h-1z", "M0,0L1,1") },
    { svg: validSvg.replace("M28,28h1v1h-1z", "M29,28h1v1h-1z") },
    { svg: validSvg.replace("M28,28h1v1h-1z", "M28,29h1v1h-1z") },
  ])("rejects malformed generate field set %#", (change) => {
    const candidate = { ...validGenerate, ...change } as Record<
      string,
      unknown
    >;
    if (typeof change.svg === "string" && !("outputBytes" in change)) {
      candidate.outputBytes = getQrTextByteLength(change.svg);
    }
    expect(isQrCodeResult(candidate)).toBe(false);
  });

  it.each([
    { extra: true },
    { text: 1 },
    { textBytes: -1 },
    { textBytes: validScan.textBytes + 1 },
    { text: "x".repeat(QR_CODE_LIMITS.maxDecodedTextBytes + 1) },
    { version: 0 },
    { version: 41 },
  ])("rejects malformed scan field set %#", (change) => {
    const candidate = { ...validScan, ...change } as Record<string, unknown>;
    if (typeof change.text === "string" && !("textBytes" in change)) {
      candidate.textBytes = getQrTextByteLength(change.text);
    }
    expect(isQrCodeResult(candidate)).toBe(false);
  });

  it("fails closed when a hostile result accessor throws", () => {
    const resultWithGetter = { ...validGenerate } as Record<string, unknown>;
    Object.defineProperty(resultWithGetter, "ok", {
      enumerable: true,
      get() {
        throw new Error("private result getter");
      },
    });

    expect(isQrCodeResult(resultWithGetter)).toBe(false);
  });

  it("fails closed when record reflection traps throw", () => {
    const prototypeTrap = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("private prototype trap");
        },
      },
    );
    expect(isQrCodeResult(prototypeTrap)).toBe(false);

    let ownKeysCalls = 0;
    const statefulOwnKeysTrap = new Proxy(
      { ...validGenerate },
      {
        ownKeys(target) {
          ownKeysCalls += 1;
          if (ownKeysCalls > 1) throw new Error("private ownKeys trap");
          return Reflect.ownKeys(target);
        },
      },
    );
    expect(isQrCodeResult(statefulOwnKeysTrap)).toBe(false);
  });
});

describe("QR Worker protocol validation", () => {
  it("accepts exact result, generate and scan messages", () => {
    expect(isQrWorkerResultMessage(resultMessage(), "qr-contract-task")).toBe(
      true,
    );
    expect(isQrWorkerExecuteMessage(generateRequest())).toBe(true);
    expect(isQrWorkerExecuteMessage(scanRequest())).toBe(true);
  });

  it.each([
    null,
    { ...resultMessage(), extra: true },
    { ...resultMessage(), type: "OTHER" },
    { ...resultMessage(), protocol: 2 },
    { ...resultMessage(), taskId: "qr-other" },
    resultMessage({ ok: true, mode: "other" }),
  ])("rejects malformed result message %#", (candidate) => {
    expect(isQrWorkerResultMessage(candidate, "qr-contract-task")).toBe(false);
  });

  it.each([
    null,
    { ...generateRequest(), extra: true },
    { ...generateRequest(), type: "OTHER" },
    { ...generateRequest(), protocol: 2 },
    { ...generateRequest(), taskId: 1 },
    { ...generateRequest(), taskId: "invalid task id" },
    { ...generateRequest(), input: null },
    generateRequest({ mode: "other" }),
    generateRequest({
      mode: "generate",
      text: "hello",
      ecc: "M",
      displaySize: 256,
      extra: true,
    }),
    generateRequest({ mode: "generate", text: 1, ecc: "M", displaySize: 256 }),
    generateRequest({
      mode: "generate",
      text: "x".repeat(QR_CODE_LIMITS.maxTextBytes + 1),
      ecc: "M",
      displaySize: 256,
    }),
    generateRequest({
      mode: "generate",
      text: "x",
      ecc: "X",
      displaySize: 256,
    }),
    generateRequest({
      mode: "generate",
      text: "x",
      ecc: "M",
      displaySize: 257,
    }),
  ])("rejects malformed execute/generate message %#", (candidate) => {
    expect(isQrWorkerExecuteMessage(candidate)).toBe(false);
  });

  it.each([
    {
      mode: "scan",
      rgba: new ArrayBuffer(16),
      width: 2,
      height: 2,
      inversionAttempts: "attemptBoth",
      extra: true,
    },
    {
      mode: "scan",
      rgba: new Uint8Array(16),
      width: 2,
      height: 2,
      inversionAttempts: "attemptBoth",
    },
    {
      mode: "scan",
      rgba: new ArrayBuffer(0),
      width: 0,
      height: 2,
      inversionAttempts: "attemptBoth",
    },
    {
      mode: "scan",
      rgba: new ArrayBuffer(0),
      width: 2,
      height: 0,
      inversionAttempts: "attemptBoth",
    },
    {
      mode: "scan",
      rgba: new ArrayBuffer(0),
      width: QR_CODE_LIMITS.maxSourceEdge + 1,
      height: 1,
      inversionAttempts: "attemptBoth",
    },
    {
      mode: "scan",
      rgba: new ArrayBuffer(0),
      width: 1,
      height: QR_CODE_LIMITS.maxSourceEdge + 1,
      inversionAttempts: "attemptBoth",
    },
    {
      mode: "scan",
      rgba: new ArrayBuffer(16),
      width: 2,
      height: 2,
      inversionAttempts: "invalid",
    },
    {
      mode: "scan",
      rgba: new ArrayBuffer(0),
      width: 2001,
      height: 2000,
      inversionAttempts: "attemptBoth",
    },
    {
      mode: "scan",
      rgba: new ArrayBuffer(15),
      width: 2,
      height: 2,
      inversionAttempts: "dontInvert",
    },
  ])("rejects malformed scan input %#", (input) => {
    expect(isQrWorkerExecuteMessage(scanRequest(input))).toBe(false);
  });

  it("fails closed without invoking Worker envelope accessors", () => {
    let resultGetterCalls = 0;
    const resultWithGetter = resultMessage() as Record<string, unknown>;
    Object.defineProperty(resultWithGetter, "result", {
      enumerable: true,
      get() {
        resultGetterCalls += 1;
        throw new Error("private Worker result getter");
      },
    });

    let inputGetterCalls = 0;
    const executeWithGetter = generateRequest() as Record<string, unknown>;
    Object.defineProperty(executeWithGetter, "input", {
      enumerable: true,
      get() {
        inputGetterCalls += 1;
        throw new Error("private Worker input getter");
      },
    });

    expect(isQrWorkerResultMessage(resultWithGetter, "qr-contract-task")).toBe(
      false,
    );
    expect(isQrWorkerExecuteMessage(executeWithGetter)).toBe(false);
    expect(resultGetterCalls).toBe(0);
    expect(inputGetterCalls).toBe(0);
  });

  it("fails closed when a second Worker envelope reflection throws", () => {
    function trapSecondOwnKeys<T extends object>(target: T): T {
      let calls = 0;
      return new Proxy(target, {
        ownKeys(value) {
          calls += 1;
          if (calls > 1) throw new Error("private envelope ownKeys trap");
          return Reflect.ownKeys(value);
        },
      });
    }

    expect(
      isQrWorkerResultMessage(
        trapSecondOwnKeys(resultMessage()),
        "qr-contract-task",
      ),
    ).toBe(false);
    expect(isQrWorkerExecuteMessage(trapSecondOwnKeys(generateRequest()))).toBe(
      false,
    );
  });
});

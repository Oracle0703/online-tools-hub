import { describe, expect, it } from "vitest";

import {
  getQrTextByteLength,
  isQrCodeResult,
  QR_CODE_LIMITS,
  QR_ERROR_CORRECTION_LEVELS,
  type QrErrorCorrectionLevel,
  type QrGenerateSuccess,
} from "../../src/tools/qr-code/contract";
import { generateQrCode, scanQrCode } from "../../src/tools/qr-code/core";

function generate(
  text: string,
  ecc: QrErrorCorrectionLevel,
): QrGenerateSuccess {
  const result = generateQrCode({
    mode: "generate",
    text,
    ecc,
    displaySize: 512,
  });
  expect(result.ok).toBe(true);
  if (!result.ok || result.mode !== "generate") {
    throw new Error("QR generation fixture failed.");
  }
  return result;
}

function rasterizeSvg(
  result: QrGenerateSuccess,
  scale = 6,
  inverted = false,
): { rgba: ArrayBuffer; width: number; height: number } {
  const width = result.modules * scale;
  const height = width;
  const pixels = new Uint8ClampedArray(width * height * 4);
  const background = inverted ? 0 : 255;
  const foreground = inverted ? 255 : 0;

  for (let offset = 0; offset < pixels.length; offset += 4) {
    pixels[offset] = background;
    pixels[offset + 1] = background;
    pixels[offset + 2] = background;
    pixels[offset + 3] = 255;
  }

  const path = result.svg.match(/<path d="([^"]*)"/u)?.[1];
  if (path === undefined) throw new Error("QR SVG path is missing.");
  const commandPattern = /M(\d+),(\d+)h1v1h-1z/gu;
  let consumedBytes = 0;
  for (const command of path.matchAll(commandPattern)) {
    if (command.index !== consumedBytes) {
      throw new Error("QR SVG contains an unexpected path command.");
    }
    consumedBytes += command[0].length;
    const moduleX = Number(command[1]);
    const moduleY = Number(command[2]);
    for (let dy = 0; dy < scale; dy += 1) {
      for (let dx = 0; dx < scale; dx += 1) {
        const offset =
          ((moduleY * scale + dy) * width + moduleX * scale + dx) * 4;
        pixels[offset] = foreground;
        pixels[offset + 1] = foreground;
        pixels[offset + 2] = foreground;
      }
    }
  }
  expect(consumedBytes).toBe(path.length);

  return { rgba: pixels.buffer, width, height };
}

describe("QR code core", () => {
  it.each(QR_ERROR_CORRECTION_LEVELS)(
    "round-trips Unicode text with %s error correction",
    (ecc) => {
      const text = `本地二维码 · ${ecc} · café · 🚀`;
      const generated = generate(text, ecc);
      const image = rasterizeSvg(generated);
      const decoded = scanQrCode({
        mode: "scan",
        ...image,
        inversionAttempts: "attemptBoth",
      });

      expect(decoded).toEqual({
        ok: true,
        mode: "scan",
        text,
        textBytes: getQrTextByteLength(text),
        version: generated.version,
      });
    },
  );

  it("recognizes an inverted generated QR code when inversion is enabled", () => {
    const text = "反色二维码 round-trip";
    const generated = generate(text, "Q");
    const image = rasterizeSvg(generated, 6, true);

    expect(
      scanQrCode({
        mode: "scan",
        ...image,
        inversionAttempts: "attemptBoth",
      }),
    ).toMatchObject({ ok: true, mode: "scan", text });
  });

  it("emits only the fixed geometric SVG grammar without plaintext leakage", () => {
    const privateText =
      'QR_PRIVATE_CANARY_91d2 https://example.invalid/<script>alert("x")</script>';
    const result = generate(privateText, "M");

    expect(result.outputBytes).toBe(getQrTextByteLength(result.svg));
    expect(result.outputBytes).toBeLessThanOrEqual(QR_CODE_LIMITS.maxSvgBytes);
    expect(isQrCodeResult(result)).toBe(true);
    expect(result.svg).not.toContain(privateText);
    expect(result.svg).not.toContain(encodeURIComponent(privateText));
    expect(result.svg).not.toContain("QR_PRIVATE_CANARY_91d2");
    expect(result.svg).not.toMatch(
      /<(?:script|style|image|use|a|text|title|desc|metadata|foreignObject)\b/iu,
    );
    expect(result.svg).not.toMatch(/\b(?:href|xlink:href|style|on\w+)\s*=/iu);
    expect(
      [...result.svg.matchAll(/<\/?([A-Za-z][\w-]*)\b/gu)].map(
        (match) => match[1],
      ),
    ).toEqual(["svg", "rect", "path", "svg"]);
    expect(result.svg).toMatch(
      /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="512" height="512" viewBox="0 0 \d+ \d+" shape-rendering="crispEdges"><rect width="\d+" height="\d+" fill="#ffffff"\/><path d="(?:M\d{1,3},\d{1,3}h1v1h-1z)*" fill="#0f172a"\/><\/svg>$/u,
    );
  });

  it("rejects empty, per-ECC oversized and globally oversized text", () => {
    expect(
      generateQrCode({
        mode: "generate",
        text: "",
        ecc: "L",
        displaySize: 256,
      }),
    ).toMatchObject({ ok: false, error: { code: "empty-input" } });

    expect(
      generateQrCode({
        mode: "generate",
        text: "x".repeat(1_274),
        ecc: "H",
        displaySize: 256,
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "capacity-exceeded", actual: 1_274, limit: 1_273 },
    });

    expect(
      generateQrCode({
        mode: "generate",
        text: "x".repeat(QR_CODE_LIMITS.maxTextBytes + 1),
        ecc: "L",
        displaySize: 256,
      }),
    ).toMatchObject({
      ok: false,
      error: {
        code: "text-too-large",
        actual: QR_CODE_LIMITS.maxTextBytes + 1,
        limit: QR_CODE_LIMITS.maxTextBytes,
      },
    });

    expect(
      generateQrCode({
        mode: "generate",
        text: "broken\ud800unicode",
        ecc: "L",
        displaySize: 256,
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "invalid-input", field: "text" },
    });
  });

  it("returns not-found for pixels with no QR code", () => {
    const width = 128;
    const height = 128;
    const pixels = new Uint8ClampedArray(width * height * 4);
    pixels.fill(255);

    expect(
      scanQrCode({
        mode: "scan",
        rgba: pixels.buffer,
        width,
        height,
        inversionAttempts: "attemptBoth",
      }),
    ).toMatchObject({ ok: false, error: { code: "not-found" } });
  });

  it("rejects oversized dimensions and mismatched RGBA before scanning", () => {
    expect(
      scanQrCode({
        mode: "scan",
        rgba: new ArrayBuffer(0),
        width: 2_001,
        height: 2_000,
        inversionAttempts: "attemptBoth",
      }),
    ).toMatchObject({
      ok: false,
      error: {
        code: "too-many-pixels",
        limit: QR_CODE_LIMITS.maxScanPixels,
      },
    });

    expect(
      scanQrCode({
        mode: "scan",
        rgba: new ArrayBuffer(15),
        width: 2,
        height: 2,
        inversionAttempts: "dontInvert",
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "invalid-rgba-length", actual: 15, limit: 16 },
    });
  });
});

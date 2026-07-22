import jsQR from "jsqr";
import { encode } from "uqr";

import {
  getQrTextByteLength,
  QR_CODE_LIMITS,
  QR_DISPLAY_SIZES,
  QR_ECC_BYTE_CAPACITY,
  QR_ERROR_CORRECTION_LEVELS,
  QR_INVERSION_ATTEMPTS,
  type QrCodeError,
  type QrCodeFailure,
  type QrCodeResult,
  type QrDisplaySize,
  type QrErrorCorrectionLevel,
  type QrGenerateInput,
  type QrGenerateSuccess,
  type QrInversionAttempts,
  type QrScanInput,
  type QrScanSuccess,
} from "./contract";

function failure(error: QrCodeError): QrCodeFailure {
  return { ok: false, error };
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function serializeSvg(
  matrix: readonly (readonly boolean[])[],
  displaySize: QrDisplaySize,
): string | null {
  const modules = matrix.length;
  if (
    modules < 21 ||
    modules > 185 ||
    matrix.some(
      (row) =>
        row.length !== modules ||
        row.some((module) => typeof module !== "boolean"),
    )
  ) {
    return null;
  }

  const commands: string[] = [];
  for (let y = 0; y < modules; y += 1) {
    const row = matrix[y]!;
    for (let x = 0; x < modules; x += 1) {
      if (row[x]) commands.push(`M${x},${y}h1v1h-1z`);
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${displaySize}" height="${displaySize}" viewBox="0 0 ${modules} ${modules}" shape-rendering="crispEdges"><rect width="${modules}" height="${modules}" fill="#ffffff"/><path d="${commands.join("")}" fill="#0f172a"/></svg>`;
}

export function generateQrCode(input: QrGenerateInput): QrCodeResult {
  if (
    input?.mode !== "generate" ||
    typeof input.text !== "string" ||
    !QR_ERROR_CORRECTION_LEVELS.includes(input.ecc) ||
    !QR_DISPLAY_SIZES.includes(input.displaySize)
  ) {
    return failure({
      code: "invalid-input",
      message: "二维码生成参数无效。",
    });
  }
  if (input.text.length > QR_CODE_LIMITS.maxTextBytes) {
    return failure({
      code: "text-too-large",
      field: "text",
      actual: input.text.length,
      limit: QR_CODE_LIMITS.maxTextBytes,
      message: "二维码文本超过 2,953 字节的安全上限。",
    });
  }
  const textBytes = getQrTextByteLength(input.text);
  if (textBytes === 0) {
    return failure({
      code: "empty-input",
      field: "text",
      message: "请输入需要写入二维码的文本。",
    });
  }
  if (hasUnpairedSurrogate(input.text)) {
    return failure({
      code: "invalid-input",
      field: "text",
      message: "文本包含不完整的 Unicode 代理项，请修正后重试。",
    });
  }
  if (textBytes > QR_CODE_LIMITS.maxTextBytes) {
    return failure({
      code: "text-too-large",
      field: "text",
      actual: textBytes,
      limit: QR_CODE_LIMITS.maxTextBytes,
      message: "二维码文本超过 2,953 字节的安全上限。",
    });
  }
  const capacity = QR_ECC_BYTE_CAPACITY[input.ecc];
  if (textBytes > capacity) {
    return failure({
      code: "capacity-exceeded",
      field: "text",
      actual: textBytes,
      limit: capacity,
      message: `当前 ${input.ecc} 级纠错最多接受 ${capacity.toLocaleString("en-US")} 字节，请缩短文本或降低纠错级别。`,
    });
  }

  try {
    const encoded = encode(input.text, {
      ecc: input.ecc,
      border: 4,
      boostEcc: false,
    });
    const svg = serializeSvg(encoded.data, input.displaySize);
    if (!svg) {
      return failure({
        code: "generation-failed",
        message: "二维码矩阵无效，生成已安全停止。",
      });
    }
    const outputBytes = getQrTextByteLength(svg);
    if (outputBytes > QR_CODE_LIMITS.maxSvgBytes) {
      return failure({
        code: "output-too-large",
        actual: outputBytes,
        limit: QR_CODE_LIMITS.maxSvgBytes,
        message: "二维码 SVG 超过 512 KiB 输出上限。",
      });
    }
    return {
      ok: true,
      mode: "generate",
      svg,
      version: encoded.version,
      modules: encoded.size,
      ecc: input.ecc,
      displaySize: input.displaySize,
      textBytes,
      outputBytes,
    } satisfies QrGenerateSuccess;
  } catch {
    return failure({
      code: "generation-failed",
      message: "当前文本无法生成二维码，请缩短内容或降低纠错级别。",
    });
  }
}

export function scanQrCode(input: QrScanInput): QrCodeResult {
  if (
    input?.mode !== "scan" ||
    !(input.rgba instanceof ArrayBuffer) ||
    !Number.isSafeInteger(input.width) ||
    !Number.isSafeInteger(input.height) ||
    !QR_INVERSION_ATTEMPTS.includes(input.inversionAttempts)
  ) {
    return failure({
      code: "invalid-input",
      message: "二维码识别参数无效。",
    });
  }
  if (
    input.width <= 0 ||
    input.height <= 0 ||
    input.width > QR_CODE_LIMITS.maxSourceEdge ||
    input.height > QR_CODE_LIMITS.maxSourceEdge
  ) {
    return failure({
      code: "invalid-dimensions",
      field: "image",
      message: "图片尺寸无效或单边超过 8,192 px 安全上限。",
    });
  }
  const pixels = input.width * input.height;
  if (!Number.isSafeInteger(pixels) || pixels > QR_CODE_LIMITS.maxScanPixels) {
    return failure({
      code: "too-many-pixels",
      field: "image",
      actual: pixels,
      limit: QR_CODE_LIMITS.maxScanPixels,
      message: "送入识别器的图片超过 4 MP 像素上限。",
    });
  }
  const expectedBytes = pixels * 4;
  if (input.rgba.byteLength !== expectedBytes) {
    return failure({
      code: "invalid-rgba-length",
      field: "image",
      actual: input.rgba.byteLength,
      limit: expectedBytes,
      message: "RGBA 像素长度与图片尺寸不一致。",
    });
  }

  try {
    const decoded = jsQR(
      new Uint8ClampedArray(input.rgba),
      input.width,
      input.height,
      { inversionAttempts: input.inversionAttempts },
    );
    if (!decoded) {
      return failure({
        code: "not-found",
        field: "image",
        message: "没有识别到二维码，请尝试更清晰、完整且留有白边的图片。",
      });
    }
    const textBytes = getQrTextByteLength(decoded.data);
    if (textBytes > QR_CODE_LIMITS.maxDecodedTextBytes) {
      return failure({
        code: "output-too-large",
        actual: textBytes,
        limit: QR_CODE_LIMITS.maxDecodedTextBytes,
        message: "二维码识别结果超过 8 KiB 输出上限。",
      });
    }
    return {
      ok: true,
      mode: "scan",
      text: decoded.data,
      textBytes,
      version: decoded.version,
    } satisfies QrScanSuccess;
  } catch {
    return failure({
      code: "scan-failed",
      message: "二维码识别失败，临时像素已释放。",
    });
  }
}

export function transformQrCode(input: QrGenerateInput | QrScanInput) {
  if (input?.mode === "generate") return generateQrCode(input);
  if (input?.mode === "scan") return scanQrCode(input);
  return failure({
    code: "invalid-input",
    message: "二维码处理模式无效。",
  });
}

export function parseQrMode(value: unknown): "generate" | "scan" | null {
  return value === "generate" || value === "scan" ? value : null;
}

export function parseQrErrorCorrectionLevel(
  value: unknown,
): QrErrorCorrectionLevel | null {
  return QR_ERROR_CORRECTION_LEVELS.includes(value as QrErrorCorrectionLevel)
    ? (value as QrErrorCorrectionLevel)
    : null;
}

export function parseQrDisplaySize(value: unknown): QrDisplaySize | null {
  return QR_DISPLAY_SIZES.includes(value as QrDisplaySize)
    ? (value as QrDisplaySize)
    : null;
}

export function parseQrInversionAttempts(
  value: unknown,
): QrInversionAttempts | null {
  return QR_INVERSION_ATTEMPTS.includes(value as QrInversionAttempts)
    ? (value as QrInversionAttempts)
    : null;
}

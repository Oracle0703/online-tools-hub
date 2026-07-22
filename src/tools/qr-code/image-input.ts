import { QR_CODE_LIMITS } from "./contract";

export type QrImageFormat = "jpeg" | "png" | "webp";

export interface QrImageMetadata {
  readonly format: QrImageFormat;
  readonly mimeType: "image/jpeg" | "image/png" | "image/webp";
  readonly width: number;
  readonly height: number;
  readonly pixels: number;
}

export type QrImageInputErrorCode =
  | "empty-file"
  | "file-too-large"
  | "unsupported-image"
  | "animated-image"
  | "corrupt-image"
  | "invalid-dimensions"
  | "source-too-large";

export interface QrImageInputError {
  readonly code: QrImageInputErrorCode;
  readonly message: string;
  readonly actual?: number;
  readonly limit?: number;
}

export type QrImageInspectionResult =
  | { readonly ok: true; readonly value: QrImageMetadata }
  | { readonly ok: false; readonly error: QrImageInputError };

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10] as const;

function failure(
  code: QrImageInputErrorCode,
  message: string,
  counts?: { readonly actual: number; readonly limit: number },
): QrImageInspectionResult {
  return { ok: false, error: { code, message, ...counts } };
}

function matchesAscii(bytes: Uint8Array, offset: number, value: string) {
  if (offset < 0 || offset + value.length > bytes.length) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (bytes[offset + index] !== value.charCodeAt(index)) return false;
  }
  return true;
}

function readUint16BigEndian(bytes: Uint8Array, offset: number) {
  return (bytes[offset]! << 8) | bytes[offset + 1]!;
}

function readUint16LittleEndian(bytes: Uint8Array, offset: number) {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function readUint24LittleEndian(bytes: Uint8Array, offset: number) {
  return (
    bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16)
  );
}

function readUint32BigEndian(bytes: Uint8Array, offset: number) {
  return (
    bytes[offset]! * 0x1000000 +
    ((bytes[offset + 1]! << 16) |
      (bytes[offset + 2]! << 8) |
      bytes[offset + 3]!)
  );
}

function readUint32LittleEndian(bytes: Uint8Array, offset: number) {
  return (
    bytes[offset]! +
    bytes[offset + 1]! * 0x100 +
    bytes[offset + 2]! * 0x10000 +
    bytes[offset + 3]! * 0x1000000
  );
}

function detectFormat(bytes: Uint8Array): QrImageFormat | null {
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return "jpeg";
  }
  if (
    bytes.length >= PNG_SIGNATURE.length &&
    PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)
  ) {
    return "png";
  }
  if (
    bytes.length >= 12 &&
    matchesAscii(bytes, 0, "RIFF") &&
    matchesAscii(bytes, 8, "WEBP")
  ) {
    return "webp";
  }
  return null;
}

function readPngMetadata(bytes: Uint8Array) {
  if (
    bytes.length < 45 ||
    readUint32BigEndian(bytes, 8) !== 13 ||
    !matchesAscii(bytes, 12, "IHDR")
  ) {
    return null;
  }
  const width = readUint32BigEndian(bytes, 16);
  const height = readUint32BigEndian(bytes, 20);
  let offset = 8;
  let sawImageData = false;
  let sawEnd = false;
  let animated = false;

  while (offset + 12 <= bytes.length) {
    const length = readUint32BigEndian(bytes, offset);
    const dataStart = offset + 8;
    if (length > bytes.length - dataStart - 4) return null;
    const nextOffset = dataStart + length + 4;
    if (matchesAscii(bytes, offset + 4, "acTL")) animated = true;
    if (matchesAscii(bytes, offset + 4, "IDAT")) sawImageData = true;
    if (matchesAscii(bytes, offset + 4, "IEND")) {
      if (length !== 0) return null;
      sawEnd = true;
      offset = nextOffset;
      break;
    }
    offset = nextOffset;
  }

  if (!sawImageData || !sawEnd || offset !== bytes.length) return null;
  return { width, height, animated };
}

function isJpegStartOfFrame(marker: number) {
  return (
    marker >= 0xc0 &&
    marker <= 0xcf &&
    marker !== 0xc4 &&
    marker !== 0xc8 &&
    marker !== 0xcc
  );
}

function readJpegMetadata(bytes: Uint8Array) {
  if (bytes.length < 11 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return null;
  }
  let offset = 2;
  while (offset < bytes.length) {
    while (offset < bytes.length && bytes[offset] !== 0xff) offset += 1;
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) return null;
    const marker = bytes[offset]!;
    offset += 1;

    if (marker === 0xd9 || marker === 0xda) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    if (offset + 2 > bytes.length) return null;
    const length = readUint16BigEndian(bytes, offset);
    if (length < 2 || length > bytes.length - offset) return null;
    if (isJpegStartOfFrame(marker)) {
      if (length < 7) return null;
      return {
        width: readUint16BigEndian(bytes, offset + 5),
        height: readUint16BigEndian(bytes, offset + 3),
        animated: false,
      };
    }
    offset += length;
  }
  return null;
}

function readVp8Dimensions(bytes: Uint8Array, offset: number, length: number) {
  if (
    length < 10 ||
    bytes[offset + 3] !== 0x9d ||
    bytes[offset + 4] !== 0x01 ||
    bytes[offset + 5] !== 0x2a
  ) {
    return null;
  }
  return {
    width: readUint16LittleEndian(bytes, offset + 6) & 0x3fff,
    height: readUint16LittleEndian(bytes, offset + 8) & 0x3fff,
  };
}

function readVp8lDimensions(bytes: Uint8Array, offset: number, length: number) {
  if (length < 5 || bytes[offset] !== 0x2f) return null;
  const bits = readUint32LittleEndian(bytes, offset + 1);
  return {
    width: (bits & 0x3fff) + 1,
    height: ((bits >>> 14) & 0x3fff) + 1,
  };
}

function readWebpMetadata(bytes: Uint8Array) {
  if (bytes.length < 20) return null;
  const declaredEnd = readUint32LittleEndian(bytes, 4) + 8;
  if (declaredEnd !== bytes.length) return null;

  let offset = 12;
  let canvasDimensions: { width: number; height: number } | null = null;
  let frameDimensions: { width: number; height: number } | null = null;
  let sawImageData = false;
  let animated = false;
  while (offset + 8 <= declaredEnd) {
    const length = readUint32LittleEndian(bytes, offset + 4);
    const dataStart = offset + 8;
    const paddedLength = length + (length & 1);
    if (paddedLength > declaredEnd - dataStart) return null;

    if (matchesAscii(bytes, offset, "VP8X")) {
      if (length !== 10 || canvasDimensions || sawImageData) return null;
      animated ||= (bytes[dataStart]! & 0x02) !== 0;
      canvasDimensions = {
        width: readUint24LittleEndian(bytes, dataStart + 4) + 1,
        height: readUint24LittleEndian(bytes, dataStart + 7) + 1,
      };
    } else if (matchesAscii(bytes, offset, "VP8 ")) {
      if (sawImageData) return null;
      sawImageData = true;
      frameDimensions = readVp8Dimensions(bytes, dataStart, length);
      if (!frameDimensions) return null;
    } else if (matchesAscii(bytes, offset, "VP8L")) {
      if (sawImageData) return null;
      sawImageData = true;
      frameDimensions = readVp8lDimensions(bytes, dataStart, length);
      if (!frameDimensions) return null;
    } else if (
      matchesAscii(bytes, offset, "ANIM") ||
      matchesAscii(bytes, offset, "ANMF")
    ) {
      animated = true;
    }
    offset = dataStart + paddedLength;
  }

  if (offset !== declaredEnd) return null;
  // Animated WebP stores each VP8/VP8L payload inside ANMF rather than as a
  // top-level image chunk. A valid VP8X canvas is enough for admission to
  // classify and reject the animation before any browser decoder runs.
  if (animated) {
    const dimensions = canvasDimensions ?? frameDimensions;
    return dimensions ? { ...dimensions, animated: true } : null;
  }
  if (!frameDimensions || !sawImageData) return null;
  if (
    canvasDimensions &&
    (canvasDimensions.width !== frameDimensions.width ||
      canvasDimensions.height !== frameDimensions.height)
  ) {
    return null;
  }
  return { ...(canvasDimensions ?? frameDimensions), animated };
}

export function validateQrImageFileSize(
  size: number,
): QrImageInputError | null {
  if (!Number.isSafeInteger(size) || size <= 0) {
    return { code: "empty-file", message: "请选择非空的图片文件。" };
  }
  if (size > QR_CODE_LIMITS.maxFileBytes) {
    return {
      code: "file-too-large",
      actual: size,
      limit: QR_CODE_LIMITS.maxFileBytes,
      message: "图片超过 20 MiB 文件上限。",
    };
  }
  return null;
}

export function inspectQrImageBytes(
  bytes: Uint8Array,
): QrImageInspectionResult {
  const sizeError = validateQrImageFileSize(bytes.byteLength);
  if (sizeError) return { ok: false, error: sizeError };
  const format = detectFormat(bytes);
  if (!format) {
    return failure(
      "unsupported-image",
      "只支持有效的 JPEG、PNG 或 WebP；SVG 和其他格式不会解码。",
    );
  }

  const parsed =
    format === "png"
      ? readPngMetadata(bytes)
      : format === "jpeg"
        ? readJpegMetadata(bytes)
        : readWebpMetadata(bytes);
  if (!parsed) {
    return failure("corrupt-image", "图片容器损坏或不完整，已停止解码。");
  }
  if (parsed.animated) {
    return failure(
      "animated-image",
      `不识别动画 ${format === "png" ? "PNG" : "WebP"}，请导出单帧静态图片。`,
    );
  }

  const { width, height } = parsed;
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return failure("invalid-dimensions", "图片宽高无效，已停止解码。");
  }
  if (
    width > QR_CODE_LIMITS.maxSourceEdge ||
    height > QR_CODE_LIMITS.maxSourceEdge ||
    width > Math.floor(QR_CODE_LIMITS.maxSourcePixels / height)
  ) {
    return failure(
      "source-too-large",
      "图片超过 16 MP 或 8,192 px 单边的解码上限。",
      {
        actual: width * height,
        limit: QR_CODE_LIMITS.maxSourcePixels,
      },
    );
  }

  return {
    ok: true,
    value: {
      format,
      mimeType:
        format === "jpeg"
          ? "image/jpeg"
          : format === "png"
            ? "image/png"
            : "image/webp",
      width,
      height,
      pixels: width * height,
    },
  };
}

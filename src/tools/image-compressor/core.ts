export const MAX_IMAGE_FILES = 20;
export const MAX_IMAGE_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_IMAGE_TOTAL_BYTES = 100 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 40_000_000;

const MEBIBYTE = 1024 * 1024;

export type ImageMemoryTier = "constrained" | "standard";

export interface ImageMemoryEnvironment {
  deviceMemoryGiB?: number;
  coarsePointer?: boolean;
}

export interface ImageMemoryLimits {
  tier: ImageMemoryTier;
  maxSourcePixels: number;
  maxTargetPixels: Readonly<Record<SupportedImageFormat, number>>;
  maxResultBytes: number;
  maxZipBytes: number;
  defaultMaximumEdge: number;
}

export interface MemorySafeImageSize extends ScaledImageSize {
  memoryLimited: boolean;
  requestedWidth: number;
  requestedHeight: number;
}

export type ImageMemoryValidationResult =
  | { ok: true; value: { pixels: number } }
  | {
      ok: false;
      error: {
        code: "device-memory-limit";
        message: string;
      };
    };

export type SupportedImageFormat = "jpeg" | "png" | "webp";
export type ImageOutputFormat = SupportedImageFormat | "original";

export interface ImageFormatDescriptor {
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  extension: "jpg" | "png" | "webp";
}

export interface ImageInspection extends ImageFormatDescriptor {
  format: SupportedImageFormat;
  animated: boolean;
}

export type ImageInspectionResult =
  | { ok: true; value: ImageInspection }
  | {
      ok: false;
      error: {
        code: "unsupported-image";
        message: string;
      };
    };

export interface ImageQueueItem {
  name: string;
  size: number;
}

export type ImageQueueErrorCode =
  | "empty-selection"
  | "too-many-files"
  | "invalid-file-size"
  | "empty-file"
  | "file-too-large"
  | "total-too-large";

export interface ImageQueueError {
  code: ImageQueueErrorCode;
  message: string;
  fileIndex?: number;
  fileName?: string;
}

export type ImageQueueValidationResult =
  | {
      ok: true;
      value: {
        fileCount: number;
        totalBytes: number;
      };
    }
  | { ok: false; error: ImageQueueError };

export interface ScaledImageSize {
  width: number;
  height: number;
  scale: number;
  resized: boolean;
}

export type ImageDimensionValidationResult =
  | {
      ok: true;
      value: { width: number; height: number; pixels: number };
    }
  | {
      ok: false;
      error: {
        code: "invalid-dimensions" | "too-many-pixels";
        message: string;
      };
    };

export interface ImageDimensions {
  format: SupportedImageFormat;
  width: number;
  height: number;
  pixels: number;
}

export type ReadImageDimensionsErrorCode =
  "unsupported-image" | "corrupt-image" | "too-many-pixels";

export type ReadImageDimensionsResult =
  | { ok: true; value: ImageDimensions }
  | {
      ok: false;
      error: {
        code: ReadImageDimensionsErrorCode;
        message: string;
        width?: number;
        height?: number;
      };
    };

export interface ZipStoreEntry {
  name: string;
  data: Uint8Array;
  /** ZIP timestamps have a two-second resolution and no time-zone marker. */
  modifiedAt?: Date;
}

const IMAGE_FORMAT_DESCRIPTORS: Readonly<
  Record<SupportedImageFormat, ImageFormatDescriptor>
> = {
  jpeg: { mimeType: "image/jpeg", extension: "jpg" },
  png: { mimeType: "image/png", extension: "png" },
  webp: { mimeType: "image/webp", extension: "webp" },
};

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_START_OF_FRAME_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);
const ZIP_UTF8_FLAG = 0x0800;
const ZIP_VERSION = 20;
const ZIP_UINT16_MAX = 0xffff;
const ZIP_UINT32_MAX = 0xffff_ffff;
const ZIP_LOCAL_HEADER_BYTES = 30;
const ZIP_CENTRAL_HEADER_BYTES = 46;
const ZIP_END_BYTES = 22;
const DEFAULT_ZIP_DATE = new Date("1980-01-01T00:00:00.000Z");

const IMAGE_MEMORY_LIMITS: Readonly<
  Record<ImageMemoryTier, ImageMemoryLimits>
> = {
  constrained: {
    tier: "constrained",
    maxSourcePixels: 12_000_000,
    maxTargetPixels: { jpeg: 8_000_000, png: 4_000_000, webp: 8_000_000 },
    maxResultBytes: 48 * MEBIBYTE,
    maxZipBytes: 24 * MEBIBYTE,
    defaultMaximumEdge: 1920,
  },
  standard: {
    tier: "standard",
    maxSourcePixels: 24_000_000,
    maxTargetPixels: {
      jpeg: 16_000_000,
      png: 8_000_000,
      webp: 16_000_000,
    },
    maxResultBytes: 96 * MEBIBYTE,
    maxZipBytes: 48 * MEBIBYTE,
    defaultMaximumEdge: 0,
  },
};

/**
 * Selects conservative limits before allocating decoded pixels. Browsers do not
 * expose a reliable free-memory value, so mobile/coarse-pointer devices and
 * devices reporting at most 4 GiB use the constrained profile.
 */
export function getImageMemoryLimits(
  environment: ImageMemoryEnvironment = {},
): ImageMemoryLimits {
  const reportedMemory = environment.deviceMemoryGiB;
  const hasLowReportedMemory =
    reportedMemory !== undefined &&
    Number.isFinite(reportedMemory) &&
    reportedMemory > 0 &&
    reportedMemory <= 4;
  const tier: ImageMemoryTier =
    hasLowReportedMemory || environment.coarsePointer
      ? "constrained"
      : "standard";

  return IMAGE_MEMORY_LIMITS[tier];
}

/** Rejects a large compressed source before any browser pixel decoder runs. */
export function validateImageSourceMemory(
  width: number,
  height: number,
  limits: ImageMemoryLimits,
): ImageMemoryValidationResult {
  const dimensions = validateImageDimensions(width, height);
  if (!dimensions.ok) {
    return {
      ok: false,
      error: {
        code: "device-memory-limit",
        message: dimensions.error.message,
      },
    };
  }

  if (dimensions.value.pixels > limits.maxSourcePixels) {
    return {
      ok: false,
      error: {
        code: "device-memory-limit",
        message: `图片尺寸为 ${width} × ${height}，当前设备的解码安全上限为 ${formatMegapixels(limits.maxSourcePixels)}。请先缩小图片，或改用内存更充足的设备。`,
      },
    };
  }

  return { ok: true, value: { pixels: dimensions.value.pixels } };
}

/**
 * Applies the requested longest edge and then an output-format-aware pixel cap.
 * PNG needs an additional RGBA copy for quantization, so its cap is lower.
 */
export function calculateMemorySafeSize(
  width: number,
  height: number,
  maximumEdge: number,
  format: SupportedImageFormat,
  limits: ImageMemoryLimits,
): MemorySafeImageSize {
  const requested = calculateContainSize(
    width,
    height,
    maximumEdge > 0 ? maximumEdge : Math.max(width, height),
  );
  const maximumPixels = limits.maxTargetPixels[format];
  const requestedPixels = requested.width * requested.height;

  if (requestedPixels <= maximumPixels) {
    return {
      ...requested,
      memoryLimited: false,
      requestedWidth: requested.width,
      requestedHeight: requested.height,
    };
  }

  const memoryScale = Math.sqrt(maximumPixels / requestedPixels);
  let targetWidth = Math.max(1, Math.floor(requested.width * memoryScale));
  let targetHeight = Math.max(1, Math.floor(requested.height * memoryScale));
  while (targetWidth * targetHeight > maximumPixels) {
    if (targetWidth >= targetHeight) targetWidth -= 1;
    else targetHeight -= 1;
  }

  return {
    width: targetWidth,
    height: targetHeight,
    scale: targetWidth / width,
    resized: true,
    memoryLimited: true,
    requestedWidth: requested.width,
    requestedHeight: requested.height,
  };
}

function formatMegapixels(pixels: number): string {
  const megapixels = pixels / 1_000_000;
  return `${Number.isInteger(megapixels) ? megapixels : megapixels.toFixed(1)} MP`;
}

/** Detects a supported image from its bytes rather than trusting its name or MIME label. */
export function detectImageFormat(
  bytes: Uint8Array,
): SupportedImageFormat | null {
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

/** Inspects the real image container and reports animation without decoding pixels. */
export function inspectImageData(bytes: Uint8Array): ImageInspectionResult {
  const format = detectImageFormat(bytes);
  if (!format) {
    return {
      ok: false,
      error: {
        code: "unsupported-image",
        message: "无法识别图片格式，请选择有效的 JPEG、PNG 或 WebP 文件。",
      },
    };
  }

  const descriptor = getImageFormatDescriptor(format);
  return {
    ok: true,
    value: {
      format,
      ...descriptor,
      animated:
        format === "png"
          ? isAnimatedPng(bytes)
          : format === "webp"
            ? isAnimatedWebP(bytes)
            : false,
    },
  };
}

/**
 * Reads dimensions directly from the image container before pixel decoding.
 * The result is also checked against MAX_IMAGE_PIXELS so callers can reject a
 * decompression bomb before createImageBitmap, Image.decode, or canvas use.
 */
export function readImageDimensions(
  bytes: Uint8Array,
  expectedFormat?: SupportedImageFormat,
): ReadImageDimensionsResult {
  const detectedFormat = detectImageFormat(bytes);
  if (!detectedFormat) {
    return expectedFormat
      ? corruptDimensionsFailure(expectedFormat)
      : {
          ok: false,
          error: {
            code: "unsupported-image",
            message: "无法识别图片格式，请选择有效的 JPEG、PNG 或 WebP 文件。",
          },
        };
  }

  if (expectedFormat && detectedFormat !== expectedFormat) {
    return {
      ok: false,
      error: {
        code: "corrupt-image",
        message: `文件内容与指定的 ${formatLabel(expectedFormat)} 格式不匹配。`,
      },
    };
  }

  const parsed =
    detectedFormat === "jpeg"
      ? readJpegDimensions(bytes)
      : detectedFormat === "png"
        ? readPngDimensions(bytes)
        : readWebPDimensions(bytes);

  if (!parsed) return corruptDimensionsFailure(detectedFormat);

  const validation = validateImageDimensions(parsed.width, parsed.height);
  if (!validation.ok) {
    if (validation.error.code === "too-many-pixels") {
      return {
        ok: false,
        error: {
          code: "too-many-pixels",
          message: `图片尺寸为 ${parsed.width} × ${parsed.height}，超过 ${MAX_IMAGE_PIXELS.toLocaleString("en-US")} 像素的安全限制。`,
          width: parsed.width,
          height: parsed.height,
        },
      };
    }
    return corruptDimensionsFailure(detectedFormat);
  }

  return {
    ok: true,
    value: {
      format: detectedFormat,
      ...validation.value,
    },
  };
}

/** Detects a valid APNG animation-control chunk before the first image-data chunk. */
export function isAnimatedPng(bytes: Uint8Array): boolean {
  if (detectImageFormat(bytes) !== "png") return false;

  let offset = PNG_SIGNATURE.length;
  while (offset + 12 <= bytes.length) {
    const chunkLength = readUint32BigEndian(bytes, offset);
    const dataStart = offset + 8;
    const dataEnd = dataStart + chunkLength;

    if (dataEnd + 4 > bytes.length) return false;

    if (matchesAscii(bytes, offset + 4, "acTL")) {
      return chunkLength === 8 && readUint32BigEndian(bytes, dataStart) > 0;
    }

    if (
      matchesAscii(bytes, offset + 4, "IDAT") ||
      matchesAscii(bytes, offset + 4, "IEND")
    ) {
      return false;
    }

    offset = dataEnd + 4;
  }

  return false;
}

/** Detects either the WebP extended-header animation bit or animation chunks. */
export function isAnimatedWebP(bytes: Uint8Array): boolean {
  if (detectImageFormat(bytes) !== "webp") return false;

  const declaredEnd = readUint32LittleEndian(bytes, 4) + 8;
  const containerEnd = Math.min(bytes.length, declaredEnd);
  if (containerEnd < 12) return false;

  let offset = 12;
  while (offset + 8 <= containerEnd) {
    const chunkLength = readUint32LittleEndian(bytes, offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + chunkLength;
    const paddedEnd = dataEnd + (chunkLength & 1);

    if (paddedEnd > containerEnd) return false;

    if (matchesAscii(bytes, offset, "VP8X")) {
      if (chunkLength >= 1 && (bytes[dataStart]! & 0x02) !== 0) return true;
    } else if (
      matchesAscii(bytes, offset, "ANIM") ||
      matchesAscii(bytes, offset, "ANMF")
    ) {
      return true;
    }

    offset = paddedEnd;
  }

  return false;
}

/** Validates the complete queue against browser-memory safety limits. */
export function validateImageQueue(
  files: readonly ImageQueueItem[],
): ImageQueueValidationResult {
  if (files.length === 0) {
    return queueFailure("empty-selection", "请至少选择一张图片。");
  }

  if (files.length > MAX_IMAGE_FILES) {
    return queueFailure(
      "too-many-files",
      `一次最多处理 ${MAX_IMAGE_FILES} 张图片，当前选择了 ${files.length} 张。`,
    );
  }

  let totalBytes = 0;

  for (const [fileIndex, file] of files.entries()) {
    const fileName = readableFileName(file.name);
    if (!Number.isSafeInteger(file.size) || file.size < 0) {
      return queueFailure(
        "invalid-file-size",
        `无法读取“${fileName}”的文件大小。`,
        fileIndex,
        fileName,
      );
    }

    if (file.size === 0) {
      return queueFailure(
        "empty-file",
        `“${fileName}”是空文件，无法压缩。`,
        fileIndex,
        fileName,
      );
    }

    if (file.size > MAX_IMAGE_FILE_BYTES) {
      return queueFailure(
        "file-too-large",
        `“${fileName}”超过单文件 ${formatBytes(MAX_IMAGE_FILE_BYTES)} 的限制。`,
        fileIndex,
        fileName,
      );
    }

    if (totalBytes > MAX_IMAGE_TOTAL_BYTES - file.size) {
      return queueFailure(
        "total-too-large",
        `所选图片总大小不能超过 ${formatBytes(MAX_IMAGE_TOTAL_BYTES)}。`,
        fileIndex,
        fileName,
      );
    }

    totalBytes += file.size;
  }

  return {
    ok: true,
    value: { fileCount: files.length, totalBytes },
  };
}

/** Rejects compressed-image bombs before allocating a full-size pixel canvas. */
export function validateImageDimensions(
  width: number,
  height: number,
): ImageDimensionValidationResult {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return {
      ok: false,
      error: {
        code: "invalid-dimensions",
        message: "图片宽高必须是大于 0 的安全整数。",
      },
    };
  }

  if (width > Math.floor(MAX_IMAGE_PIXELS / height)) {
    return {
      ok: false,
      error: {
        code: "too-many-pixels",
        message: `图片像素总数不能超过 ${MAX_IMAGE_PIXELS.toLocaleString("en-US")}。`,
      },
    };
  }

  return { ok: true, value: { width, height, pixels: width * height } };
}

/** Scales an image inside a square maximum edge without ever enlarging it. */
export function calculateContainSize(
  width: number,
  height: number,
  maximumEdge: number,
): ScaledImageSize {
  for (const [label, value] of [
    ["图片宽度", width],
    ["图片高度", height],
    ["最大边长", maximumEdge],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`${label}必须是大于 0 的安全整数。`);
    }
  }

  const scale = Math.min(1, maximumEdge / Math.max(width, height));
  if (scale === 1) {
    return { width, height, scale, resized: false };
  }

  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    scale,
    resized: true,
  };
}

export function getImageFormatDescriptor(
  format: SupportedImageFormat,
): ImageFormatDescriptor {
  return IMAGE_FORMAT_DESCRIPTORS[format];
}

export function resolveOutputFormat(
  sourceFormat: SupportedImageFormat,
  requestedFormat: ImageOutputFormat = "original",
): SupportedImageFormat {
  return requestedFormat === "original" ? sourceFormat : requestedFormat;
}

/** Builds a flat, cross-platform-safe output name while preserving Unicode text. */
export function createOutputFileName(
  inputName: string,
  format: SupportedImageFormat,
  suffix = "compressed",
): string {
  const pathParts = inputName.replaceAll("\\", "/").split("/");
  const baseName = pathParts.at(-1) ?? "";
  const lastDot = baseName.lastIndexOf(".");
  const rawStem = lastDot > 0 ? baseName.slice(0, lastDot) : baseName;
  let stem = sanitizeFileNamePart(rawStem, "image");
  const safeSuffix = sanitizeFileNamePart(suffix, "compressed");

  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu.test(stem)) {
    stem = `image-${stem}`;
  }

  const extension = getImageFormatDescriptor(format).extension;
  return `${stem}-${safeSuffix}.${extension}`;
}

/** Formats an exact byte count with deterministic binary units. */
export function formatBytes(bytes: number): string {
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw new RangeError("字节数必须是非负安全整数。");
  }

  const units = ["B", "KiB", "MiB", "GiB"] as const;
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const precision = unitIndex === 0 ? 0 : value < 10 ? 2 : value < 100 ? 1 : 0;
  return `${trimFixed(value, precision)} ${units[unitIndex]}`;
}

/** Reports savings relative to the source; larger results are not presented as savings. */
export function formatSavings(
  originalBytes: number,
  outputBytes: number,
): string {
  if (!Number.isSafeInteger(originalBytes) || originalBytes <= 0) {
    throw new RangeError("原始文件大小必须是大于 0 的安全整数。");
  }
  if (!Number.isSafeInteger(outputBytes) || outputBytes < 0) {
    throw new RangeError("输出文件大小必须是非负安全整数。");
  }

  if (outputBytes === originalBytes) return "未节省";

  const percentage =
    (Math.abs(originalBytes - outputBytes) / originalBytes) * 100;
  const formatted = trimFixed(percentage, percentage < 10 ? 1 : 0);
  return outputBytes < originalBytes
    ? `节省 ${formatted}%`
    : `增大 ${formatted}%`;
}

/** Maps a 0–100 quality setting linearly to PNG quantizer's 2–256 colors. */
export function qualityToPngPaletteColors(quality: number): number {
  if (!Number.isFinite(quality) || quality < 0 || quality > 100) {
    throw new RangeError("PNG 质量必须是 0–100 之间的数字。");
  }

  return Math.round(2 + (quality / 100) * 254);
}

/** Calculates the standard IEEE CRC-32 used by ZIP. */
export function crc32(data: Uint8Array): number {
  let checksum = 0xffff_ffff;
  for (const byte of data) {
    checksum = CRC32_TABLE[(checksum ^ byte) & 0xff]! ^ (checksum >>> 8);
  }
  return (checksum ^ 0xffff_ffff) >>> 0;
}

/**
 * Creates a ZIP32 archive using method 0 (Store): data is never compressed a
 * second time, which is ideal for already-compressed images.
 */
export function createStoreZip(entries: readonly ZipStoreEntry[]): Uint8Array {
  if (entries.length === 0) {
    throw new RangeError("至少需要一个文件才能创建 ZIP 归档。");
  }
  if (entries.length > ZIP_UINT16_MAX) {
    throw new RangeError(`ZIP32 最多只能包含 ${ZIP_UINT16_MAX} 个文件。`);
  }

  const encoder = new TextEncoder();
  const seenNames = new Set<string>();
  const prepared: PreparedZipEntry[] = [];
  let localAreaBytes = 0;
  let centralAreaBytes = 0;

  for (const [index, entry] of entries.entries()) {
    if (!(entry.data instanceof Uint8Array)) {
      throw new TypeError(`ZIP 中第 ${index + 1} 个文件的数据不是字节数组。`);
    }

    const name = sanitizeZipEntryName(entry.name, index);
    if (seenNames.has(name)) {
      throw new RangeError(`ZIP 中存在重复文件名“${name}”。`);
    }
    seenNames.add(name);

    const nameBytes = encoder.encode(name);
    if (nameBytes.length > ZIP_UINT16_MAX) {
      throw new RangeError(
        `文件“${readableFileName(name)}”的 UTF-8 文件名超过 ZIP32 的 65535 字节限制。`,
      );
    }

    const dataBytes = entry.data.byteLength;
    if (dataBytes > ZIP_UINT32_MAX) {
      throw new RangeError(
        `文件“${readableFileName(name)}”超过 ZIP32 的 4 GiB 大小限制。`,
      );
    }

    const localRecordBytes =
      ZIP_LOCAL_HEADER_BYTES + nameBytes.length + dataBytes;
    const centralRecordBytes = ZIP_CENTRAL_HEADER_BYTES + nameBytes.length;
    assertZip32LayoutValue(localAreaBytes, "ZIP 本地文件偏移");
    assertZip32LayoutValue(
      localAreaBytes + localRecordBytes,
      "ZIP 本地区域大小",
    );
    assertZip32LayoutValue(
      centralAreaBytes + centralRecordBytes,
      "ZIP 中央目录大小",
    );

    const { dosDate, dosTime } = toDosDateTime(
      entry.modifiedAt ?? DEFAULT_ZIP_DATE,
      name,
    );
    prepared.push({
      data: entry.data,
      dataBytes,
      nameBytes,
      checksum: crc32(entry.data),
      dosDate,
      dosTime,
      localOffset: localAreaBytes,
    });
    localAreaBytes += localRecordBytes;
    centralAreaBytes += centralRecordBytes;
  }

  const totalBytes = localAreaBytes + centralAreaBytes + ZIP_END_BYTES;
  assertZip32LayoutValue(localAreaBytes, "ZIP 中央目录偏移");
  assertZip32LayoutValue(centralAreaBytes, "ZIP 中央目录大小");
  assertZip32LayoutValue(totalBytes, "ZIP 归档大小");

  let archive: Uint8Array;
  try {
    archive = new Uint8Array(totalBytes);
  } catch {
    throw new RangeError("ZIP 归档过大，当前浏览器无法分配足够内存。");
  }

  const view = new DataView(archive.buffer);
  let offset = 0;

  for (const entry of prepared) {
    view.setUint32(offset, 0x0403_4b50, true);
    view.setUint16(offset + 4, ZIP_VERSION, true);
    view.setUint16(offset + 6, ZIP_UTF8_FLAG, true);
    view.setUint16(offset + 8, 0, true);
    view.setUint16(offset + 10, entry.dosTime, true);
    view.setUint16(offset + 12, entry.dosDate, true);
    view.setUint32(offset + 14, entry.checksum, true);
    view.setUint32(offset + 18, entry.dataBytes, true);
    view.setUint32(offset + 22, entry.dataBytes, true);
    view.setUint16(offset + 26, entry.nameBytes.length, true);
    view.setUint16(offset + 28, 0, true);
    offset += ZIP_LOCAL_HEADER_BYTES;
    archive.set(entry.nameBytes, offset);
    offset += entry.nameBytes.length;
    archive.set(entry.data, offset);
    offset += entry.dataBytes;
  }

  for (const entry of prepared) {
    view.setUint32(offset, 0x0201_4b50, true);
    view.setUint16(offset + 4, ZIP_VERSION, true);
    view.setUint16(offset + 6, ZIP_VERSION, true);
    view.setUint16(offset + 8, ZIP_UTF8_FLAG, true);
    view.setUint16(offset + 10, 0, true);
    view.setUint16(offset + 12, entry.dosTime, true);
    view.setUint16(offset + 14, entry.dosDate, true);
    view.setUint32(offset + 16, entry.checksum, true);
    view.setUint32(offset + 20, entry.dataBytes, true);
    view.setUint32(offset + 24, entry.dataBytes, true);
    view.setUint16(offset + 28, entry.nameBytes.length, true);
    view.setUint16(offset + 30, 0, true);
    view.setUint16(offset + 32, 0, true);
    view.setUint16(offset + 34, 0, true);
    view.setUint16(offset + 36, 0, true);
    view.setUint32(offset + 38, 0, true);
    view.setUint32(offset + 42, entry.localOffset, true);
    offset += ZIP_CENTRAL_HEADER_BYTES;
    archive.set(entry.nameBytes, offset);
    offset += entry.nameBytes.length;
  }

  view.setUint32(offset, 0x0605_4b50, true);
  view.setUint16(offset + 4, 0, true);
  view.setUint16(offset + 6, 0, true);
  view.setUint16(offset + 8, entries.length, true);
  view.setUint16(offset + 10, entries.length, true);
  view.setUint32(offset + 12, centralAreaBytes, true);
  view.setUint32(offset + 16, localAreaBytes, true);
  view.setUint16(offset + 20, 0, true);

  return archive;
}

interface PreparedZipEntry {
  data: Uint8Array;
  dataBytes: number;
  nameBytes: Uint8Array;
  checksum: number;
  dosDate: number;
  dosTime: number;
  localOffset: number;
}

interface ParsedDimensions {
  width: number;
  height: number;
}

function queueFailure(
  code: ImageQueueErrorCode,
  message: string,
  fileIndex?: number,
  fileName?: string,
): { ok: false; error: ImageQueueError } {
  return {
    ok: false,
    error: {
      code,
      message,
      ...(fileIndex === undefined ? {} : { fileIndex }),
      ...(fileName === undefined ? {} : { fileName }),
    },
  };
}

function matchesAscii(
  bytes: Uint8Array,
  offset: number,
  expected: string,
): boolean {
  if (offset < 0 || offset + expected.length > bytes.length) return false;
  for (let index = 0; index < expected.length; index += 1) {
    if (bytes[offset + index] !== expected.charCodeAt(index)) return false;
  }
  return true;
}

function readUint32BigEndian(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! * 0x100_0000 +
    bytes[offset + 1]! * 0x1_0000 +
    bytes[offset + 2]! * 0x100 +
    bytes[offset + 3]!
  );
}

function readUint32LittleEndian(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! +
    bytes[offset + 1]! * 0x100 +
    bytes[offset + 2]! * 0x1_0000 +
    bytes[offset + 3]! * 0x100_0000
  );
}

function readUint16BigEndian(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! * 0x100 + bytes[offset + 1]!;
}

function readUint16LittleEndian(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! + bytes[offset + 1]! * 0x100;
}

function readUint24LittleEndian(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! + bytes[offset + 1]! * 0x100 + bytes[offset + 2]! * 0x1_0000
  );
}

function readPngDimensions(bytes: Uint8Array): ParsedDimensions | null {
  const minimumHeaderBytes = PNG_SIGNATURE.length + 12 + 13;
  if (bytes.length < minimumHeaderBytes) return null;
  if (readUint32BigEndian(bytes, 8) !== 13) return null;
  if (!matchesAscii(bytes, 12, "IHDR")) return null;

  return {
    width: readUint32BigEndian(bytes, 16),
    height: readUint32BigEndian(bytes, 20),
  };
}

function readJpegDimensions(bytes: Uint8Array): ParsedDimensions | null {
  let offset = 2;

  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) return null;

    const marker = bytes[offset]!;
    offset += 1;

    if (marker === 0x00) return null;
    if (
      marker === 0xd8 ||
      marker === 0x01 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null;
    if (offset + 2 > bytes.length) return null;

    const segmentLength = readUint16BigEndian(bytes, offset);
    if (segmentLength < 2) return null;
    const segmentEnd = offset + segmentLength;
    if (segmentEnd > bytes.length) return null;

    if (JPEG_START_OF_FRAME_MARKERS.has(marker)) {
      if (segmentLength < 8) return null;
      const componentCount = bytes[offset + 7]!;
      if (componentCount === 0 || segmentLength !== 8 + componentCount * 3) {
        return null;
      }
      return {
        height: readUint16BigEndian(bytes, offset + 3),
        width: readUint16BigEndian(bytes, offset + 5),
      };
    }

    offset = segmentEnd;
  }

  return null;
}

function readWebPDimensions(bytes: Uint8Array): ParsedDimensions | null {
  const riffPayloadBytes = readUint32LittleEndian(bytes, 4);
  if (riffPayloadBytes < 4) return null;

  const containerEnd = riffPayloadBytes + 8;
  if (containerEnd > bytes.length) return null;

  let offset = 12;
  while (offset + 8 <= containerEnd) {
    const chunkLength = readUint32LittleEndian(bytes, offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + chunkLength;
    const paddedEnd = dataEnd + (chunkLength & 1);
    if (paddedEnd > containerEnd) return null;

    if (matchesAscii(bytes, offset, "VP8X")) {
      if (chunkLength !== 10) return null;
      return {
        width: readUint24LittleEndian(bytes, dataStart + 4) + 1,
        height: readUint24LittleEndian(bytes, dataStart + 7) + 1,
      };
    }

    if (matchesAscii(bytes, offset, "VP8 ")) {
      if (
        chunkLength < 10 ||
        (bytes[dataStart]! & 1) !== 0 ||
        bytes[dataStart + 3] !== 0x9d ||
        bytes[dataStart + 4] !== 0x01 ||
        bytes[dataStart + 5] !== 0x2a
      ) {
        return null;
      }
      return {
        width: readUint16LittleEndian(bytes, dataStart + 6) & 0x3fff,
        height: readUint16LittleEndian(bytes, dataStart + 8) & 0x3fff,
      };
    }

    if (matchesAscii(bytes, offset, "VP8L")) {
      if (chunkLength < 5 || bytes[dataStart] !== 0x2f) return null;
      const dimensions = readUint32LittleEndian(bytes, dataStart + 1);
      if (dimensions >>> 29 !== 0) return null;
      return {
        width: (dimensions & 0x3fff) + 1,
        height: ((dimensions >>> 14) & 0x3fff) + 1,
      };
    }

    offset = paddedEnd;
  }

  return null;
}

function corruptDimensionsFailure(
  format: SupportedImageFormat,
): ReadImageDimensionsResult {
  return {
    ok: false,
    error: {
      code: "corrupt-image",
      message: `${formatLabel(format)} 图片头已损坏、被截断或缺少有效尺寸。`,
    },
  };
}

function formatLabel(format: SupportedImageFormat): string {
  return format === "jpeg" ? "JPEG" : format === "png" ? "PNG" : "WebP";
}

function sanitizeFileNamePart(
  value: string,
  fallback: string,
  maximumCodePoints: number | null = 120,
): string {
  let sanitized: string;
  try {
    sanitized = value.normalize("NFC");
  } catch {
    sanitized = value;
  }

  sanitized = sanitized
    .replace(/[\p{Cc}\p{Cf}\p{Cs}<>:"/\\|?*]/gu, " ")
    .replace(/\s+/gu, " ")
    .replace(/^[.\s]+|[.\s]+$/gu, "")
    .trim();

  const limited =
    maximumCodePoints === null
      ? sanitized
      : Array.from(sanitized).slice(0, maximumCodePoints).join("");
  return limited || fallback;
}

function readableFileName(name: string): string {
  return sanitizeFileNamePart(name, "未命名文件");
}

function trimFixed(value: number, precision: number): string {
  return value
    .toFixed(precision)
    .replace(/\.0+$/u, "")
    .replace(/(\.\d*?)0+$/u, "$1");
}

function sanitizeZipEntryName(name: string, index: number): string {
  if (findUnpairedSurrogate(name) !== -1) {
    throw new RangeError(`ZIP 文件名“${readableFileName(name)}”包含无效字符。`);
  }

  const pathParts = name.replaceAll("\\", "/").split("/");
  let safeName = sanitizeFileNamePart(
    pathParts.at(-1) ?? "",
    `file-${index + 1}`,
    null,
  );
  const stem = safeName.split(".", 1)[0] ?? safeName;
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu.test(stem)) {
    safeName = `file-${safeName}`;
  }

  return safeName;
}

function findUnpairedSurrogate(value: string): number {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return index;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return index;
    }
  }
  return -1;
}

function assertZip32LayoutValue(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > ZIP_UINT32_MAX) {
    throw new RangeError(`${label}超过 ZIP32 的 4 GiB 边界。`);
  }
}

function toDosDateTime(
  input: Date,
  fileName: string,
): { dosDate: number; dosTime: number } {
  const time = input.getTime();
  if (!Number.isFinite(time)) {
    throw new RangeError(`文件“${readableFileName(fileName)}”的修改时间无效。`);
  }

  const year = Math.min(2107, Math.max(1980, input.getUTCFullYear()));
  const month = input.getUTCFullYear() < 1980 ? 1 : input.getUTCMonth() + 1;
  const day = input.getUTCFullYear() < 1980 ? 1 : input.getUTCDate();
  const hours = input.getUTCFullYear() < 1980 ? 0 : input.getUTCHours();
  const minutes = input.getUTCFullYear() < 1980 ? 0 : input.getUTCMinutes();
  const seconds = input.getUTCFullYear() < 1980 ? 0 : input.getUTCSeconds();

  return {
    dosDate: ((year - 1980) << 9) | (month << 5) | day,
    dosTime: (hours << 11) | (minutes << 5) | Math.floor(seconds / 2),
  };
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? 0xedb8_8320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

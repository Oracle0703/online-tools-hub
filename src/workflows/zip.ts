export const MAX_WORKFLOW_ZIP_ENTRIES = 64;
export const MAX_WORKFLOW_ZIP_ENTRY_BYTES = 64 * 1024 * 1024;
export const MAX_WORKFLOW_ZIP_ARCHIVE_BYTES = 128 * 1024 * 1024;

const ZIP_VERSION = 20;
const ZIP_UTF8_FLAG = 0x0800;
const ZIP_UINT16_MAX = 0xffff;
const ZIP_UINT32_MAX = 0xffff_ffff;
const ZIP_LOCAL_HEADER_BYTES = 30;
const ZIP_CENTRAL_HEADER_BYTES = 46;
const ZIP_END_BYTES = 22;
const ZIP_COPY_CHUNK_BYTES = 1024 * 1024;
const ZIP_EPOCH_DATE = 0x0021;
const ZIP_EPOCH_TIME = 0;

export const workflowZipErrorCodes = [
  "invalid-entry",
  "entry-limit",
  "entry-size-limit",
  "archive-size-limit",
  "unsafe-name",
  "duplicate-name",
  "cancelled",
  "allocation-failed",
] as const;

export type WorkflowZipErrorCode = (typeof workflowZipErrorCodes)[number];

const ZIP_ERROR_MESSAGES: Readonly<Record<WorkflowZipErrorCode, string>> =
  Object.freeze({
    "invalid-entry": "The ZIP entry is invalid.",
    "entry-limit": "The ZIP archive has too many entries.",
    "entry-size-limit": "A ZIP entry exceeds the size limit.",
    "archive-size-limit": "The ZIP archive exceeds the size limit.",
    "unsafe-name": "A ZIP entry has an unsafe download name.",
    "duplicate-name": "The ZIP archive contains duplicate download names.",
    cancelled: "ZIP creation was cancelled.",
    "allocation-failed": "The ZIP archive could not be allocated.",
  });

/** Public failures never include an entry name or a fragment of its body. */
export class WorkflowZipError extends Error {
  readonly code: WorkflowZipErrorCode;

  constructor(code: WorkflowZipErrorCode) {
    super(ZIP_ERROR_MESSAGES[code]);
    this.name = "WorkflowZipError";
    this.code = code;
  }
}

export interface WorkflowZipEntry {
  readonly data: ArrayBuffer | Uint8Array;
  /** Omit this for the privacy-preserving `item-001.bin` naming scheme. */
  readonly downloadName?: string;
}

export interface WorkflowZipOptions {
  readonly maxEntries?: number;
  readonly maxEntryBytes?: number;
  readonly maxArchiveBytes?: number;
  readonly signal?: AbortSignal;
}

interface PreparedZipEntry {
  readonly data: Uint8Array;
  readonly dataBytes: number;
  readonly nameBytes: Uint8Array;
  readonly localOffset: number;
}

function fail(code: WorkflowZipErrorCode): never {
  throw new WorkflowZipError(code);
}

function assertCancellation(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) fail("cancelled");
}

async function cancellationCheckpoint(
  signal: AbortSignal | undefined,
): Promise<void> {
  assertCancellation(signal);
  await Promise.resolve();
  assertCancellation(signal);
}

async function hostCancellationCheckpoint(
  signal: AbortSignal | undefined,
): Promise<void> {
  assertCancellation(signal);
  await new Promise<void>((resolve) => {
    globalThis.setTimeout(resolve, 0);
  });
  assertCancellation(signal);
}

function assertBoundedLimit(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > fallback) {
    throw new RangeError(`${name} must be a positive bounded safe integer.`);
  }
  return resolved;
}

function readDenseEntries(
  value: readonly WorkflowZipEntry[],
): readonly unknown[] {
  try {
    if (
      !Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Array.prototype
    ) {
      return fail("invalid-entry");
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length !== value.length + 1 || !keys.includes("length")) {
      return fail("invalid-entry");
    }
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !("value" in descriptor)
      ) {
        return fail("invalid-entry");
      }
    }
    return value;
  } catch (error) {
    if (error instanceof WorkflowZipError) throw error;
    return fail("invalid-entry");
  }
}

function readEntry(value: unknown): {
  readonly data: unknown;
  readonly downloadName: unknown;
} {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return fail("invalid-entry");
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return fail("invalid-entry");
    }
    const allowed = new Set(["data", "downloadName"]);
    const record = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string" || !allowed.has(key)) {
        return fail("invalid-entry");
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !("value" in descriptor)
      ) {
        return fail("invalid-entry");
      }
      record[key] = descriptor.value;
    }
    if (!Object.prototype.hasOwnProperty.call(record, "data")) {
      return fail("invalid-entry");
    }
    return { data: record.data, downloadName: record.downloadName };
  } catch (error) {
    if (error instanceof WorkflowZipError) throw error;
    return fail("invalid-entry");
  }
}

function isSharedArrayBuffer(value: unknown): boolean {
  return (
    typeof SharedArrayBuffer !== "undefined" &&
    value instanceof SharedArrayBuffer
  );
}

function readEntryData(value: unknown): Uint8Array {
  try {
    if (value instanceof ArrayBuffer && !isSharedArrayBuffer(value)) {
      return new Uint8Array(value);
    }
    if (value instanceof Uint8Array && !isSharedArrayBuffer(value.buffer)) {
      return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
  } catch {
    return fail("invalid-entry");
  }
  return fail("invalid-entry");
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const current = value.charCodeAt(index);
    if (current >= 0xd800 && current <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (current >= 0xdc00 && current <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function truncateUtf8(value: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  let result = "";
  for (const codePoint of value) {
    if (encoder.encode(result + codePoint).byteLength > maxBytes) break;
    result += codePoint;
  }
  return result;
}

/**
 * Converts a caller-provided label to one basename. Directory components,
 * traversal segments, device names and control characters cannot reach ZIP
 * metadata. Omitting the label is safer and uses a fixed numbered name.
 */
export function sanitizeWorkflowZipDownloadName(
  value: string | undefined,
  index: number,
): string {
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new RangeError("index must be a non-negative safe integer.");
  }
  const fallback = `item-${String(index + 1).padStart(3, "0")}.bin`;
  if (value === undefined) return fallback;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4096 ||
    hasUnpairedSurrogate(value)
  ) {
    return fail("unsafe-name");
  }

  let normalized: string;
  try {
    normalized = value.normalize("NFC");
  } catch {
    return fail("unsafe-name");
  }
  const basename = normalized.replaceAll("\\", "/").split("/").at(-1) ?? "";
  let sanitized = basename
    .replace(/[\p{Cc}\p{Cf}\p{Cs}<>:"/\\|?*]/gu, " ")
    .replace(/\s+/gu, " ")
    .replace(/^[.\s]+|[.\s]+$/gu, "")
    .trim();
  sanitized = Array.from(sanitized).slice(0, 96).join("");
  sanitized = truncateUtf8(sanitized, 255);
  if (sanitized.length === 0 || sanitized === "." || sanitized === "..") {
    return fallback;
  }
  const stem = sanitized.split(".", 1)[0] ?? sanitized;
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu.test(stem)) {
    sanitized = `item-${sanitized}`;
  }
  return sanitized;
}

const CRC32_TABLE: readonly number[] = Object.freeze(
  Array.from({ length: 256 }, (_, value) => {
    let checksum = value;
    for (let bit = 0; bit < 8; bit += 1) {
      checksum =
        (checksum & 1) === 1 ? 0xedb8_8320 ^ (checksum >>> 1) : checksum >>> 1;
    }
    return checksum >>> 0;
  }),
);

async function calculateCrc32(
  data: Uint8Array,
  signal: AbortSignal | undefined,
): Promise<number> {
  let checksum = 0xffff_ffff;
  for (let offset = 0; offset < data.byteLength; offset += 1) {
    checksum =
      CRC32_TABLE[(checksum ^ data[offset]!) & 0xff]! ^ (checksum >>> 8);
    if ((offset + 1) % ZIP_COPY_CHUNK_BYTES === 0) {
      await hostCancellationCheckpoint(signal);
    }
  }
  assertCancellation(signal);
  return (checksum ^ 0xffff_ffff) >>> 0;
}

async function copyEntryData(
  target: Uint8Array,
  source: Uint8Array,
  offset: number,
  signal: AbortSignal | undefined,
): Promise<number> {
  for (let sourceOffset = 0; sourceOffset < source.byteLength;) {
    const end = Math.min(
      sourceOffset + ZIP_COPY_CHUNK_BYTES,
      source.byteLength,
    );
    target.set(source.subarray(sourceOffset, end), offset);
    offset += end - sourceOffset;
    sourceOffset = end;
    if (source.byteLength >= ZIP_COPY_CHUNK_BYTES) {
      await hostCancellationCheckpoint(signal);
    } else {
      await cancellationCheckpoint(signal);
    }
  }
  return offset;
}

function assertZip32(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > ZIP_UINT32_MAX) {
    fail("archive-size-limit");
  }
}

/**
 * Builds a deterministic ZIP32 archive with method 0 (STORE). The fixed ZIP
 * epoch timestamp prevents source file times from leaking into metadata.
 */
export async function createWorkflowStoreZip(
  entries: readonly WorkflowZipEntry[],
  options: WorkflowZipOptions = {},
): Promise<ArrayBuffer> {
  const maxEntries = assertBoundedLimit(
    options.maxEntries,
    MAX_WORKFLOW_ZIP_ENTRIES,
    "maxEntries",
  );
  const maxEntryBytes = assertBoundedLimit(
    options.maxEntryBytes,
    MAX_WORKFLOW_ZIP_ENTRY_BYTES,
    "maxEntryBytes",
  );
  const maxArchiveBytes = assertBoundedLimit(
    options.maxArchiveBytes,
    MAX_WORKFLOW_ZIP_ARCHIVE_BYTES,
    "maxArchiveBytes",
  );
  const rawEntries = readDenseEntries(entries);
  if (rawEntries.length === 0 || rawEntries.length > maxEntries) {
    fail("entry-limit");
  }
  if (rawEntries.length > ZIP_UINT16_MAX) fail("entry-limit");

  const encoder = new TextEncoder();
  const seenNames = new Set<string>();
  const prepared: PreparedZipEntry[] = [];
  let localAreaBytes = 0;
  let centralAreaBytes = 0;

  for (const [index, rawEntry] of rawEntries.entries()) {
    await cancellationCheckpoint(options.signal);
    const entry = readEntry(rawEntry);
    const data = readEntryData(entry.data);
    if (data.byteLength > maxEntryBytes) fail("entry-size-limit");
    const downloadName = sanitizeWorkflowZipDownloadName(
      entry.downloadName === undefined
        ? undefined
        : typeof entry.downloadName === "string"
          ? entry.downloadName
          : fail("unsafe-name"),
      index,
    );
    if (seenNames.has(downloadName)) fail("duplicate-name");
    seenNames.add(downloadName);
    const nameBytes = encoder.encode(downloadName);
    if (nameBytes.byteLength > ZIP_UINT16_MAX) fail("unsafe-name");

    const localRecordBytes =
      ZIP_LOCAL_HEADER_BYTES + nameBytes.byteLength + data.byteLength;
    const centralRecordBytes = ZIP_CENTRAL_HEADER_BYTES + nameBytes.byteLength;
    assertZip32(localAreaBytes);
    assertZip32(localAreaBytes + localRecordBytes);
    assertZip32(centralAreaBytes + centralRecordBytes);
    prepared.push(
      Object.freeze({
        data,
        dataBytes: data.byteLength,
        nameBytes,
        localOffset: localAreaBytes,
      }),
    );
    localAreaBytes += localRecordBytes;
    centralAreaBytes += centralRecordBytes;
  }

  const archiveBytes = localAreaBytes + centralAreaBytes + ZIP_END_BYTES;
  assertZip32(archiveBytes);
  if (archiveBytes > maxArchiveBytes) fail("archive-size-limit");
  assertCancellation(options.signal);

  let archive: Uint8Array;
  try {
    archive = new Uint8Array(archiveBytes);
  } catch {
    return fail("allocation-failed");
  }
  const view = new DataView(archive.buffer);
  const checksums: number[] = [];
  let offset = 0;

  for (const entry of prepared) {
    assertCancellation(options.signal);
    if (entry.data.byteLength !== entry.dataBytes) fail("invalid-entry");
    const headerOffset = offset;
    view.setUint32(offset, 0x0403_4b50, true);
    view.setUint16(offset + 4, ZIP_VERSION, true);
    view.setUint16(offset + 6, ZIP_UTF8_FLAG, true);
    view.setUint16(offset + 8, 0, true);
    view.setUint16(offset + 10, ZIP_EPOCH_TIME, true);
    view.setUint16(offset + 12, ZIP_EPOCH_DATE, true);
    view.setUint32(offset + 14, 0, true);
    view.setUint32(offset + 18, entry.dataBytes, true);
    view.setUint32(offset + 22, entry.dataBytes, true);
    view.setUint16(offset + 26, entry.nameBytes.byteLength, true);
    view.setUint16(offset + 28, 0, true);
    offset += ZIP_LOCAL_HEADER_BYTES;
    archive.set(entry.nameBytes, offset);
    offset += entry.nameBytes.byteLength;
    const dataOffset = offset;
    offset = await copyEntryData(archive, entry.data, offset, options.signal);
    const checksum = await calculateCrc32(
      archive.subarray(dataOffset, offset),
      options.signal,
    );
    checksums.push(checksum);
    view.setUint32(headerOffset + 14, checksum, true);
  }

  const centralOffset = offset;
  for (const [index, entry] of prepared.entries()) {
    assertCancellation(options.signal);
    view.setUint32(offset, 0x0201_4b50, true);
    view.setUint16(offset + 4, ZIP_VERSION, true);
    view.setUint16(offset + 6, ZIP_VERSION, true);
    view.setUint16(offset + 8, ZIP_UTF8_FLAG, true);
    view.setUint16(offset + 10, 0, true);
    view.setUint16(offset + 12, ZIP_EPOCH_TIME, true);
    view.setUint16(offset + 14, ZIP_EPOCH_DATE, true);
    view.setUint32(offset + 16, checksums[index]!, true);
    view.setUint32(offset + 20, entry.dataBytes, true);
    view.setUint32(offset + 24, entry.dataBytes, true);
    view.setUint16(offset + 28, entry.nameBytes.byteLength, true);
    view.setUint16(offset + 30, 0, true);
    view.setUint16(offset + 32, 0, true);
    view.setUint16(offset + 34, 0, true);
    view.setUint16(offset + 36, 0, true);
    view.setUint32(offset + 38, 0, true);
    view.setUint32(offset + 42, entry.localOffset, true);
    offset += ZIP_CENTRAL_HEADER_BYTES;
    archive.set(entry.nameBytes, offset);
    offset += entry.nameBytes.byteLength;
    await cancellationCheckpoint(options.signal);
  }

  view.setUint32(offset, 0x0605_4b50, true);
  view.setUint16(offset + 4, 0, true);
  view.setUint16(offset + 6, 0, true);
  view.setUint16(offset + 8, prepared.length, true);
  view.setUint16(offset + 10, prepared.length, true);
  view.setUint32(offset + 12, offset - centralOffset, true);
  view.setUint32(offset + 16, centralOffset, true);
  view.setUint16(offset + 20, 0, true);
  assertCancellation(options.signal);
  const result = archive.buffer;
  if (!(result instanceof ArrayBuffer)) return fail("allocation-failed");
  return result;
}

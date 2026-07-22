export const QR_CODE_LIMITS = Object.freeze({
  maxTextBytes: 2_953,
  maxDecodedTextBytes: 8 * 1024,
  maxFileBytes: 20 * 1024 * 1024,
  maxSourcePixels: 16_000_000,
  maxSourceEdge: 8_192,
  maxScanPixels: 4_000_000,
  maxSvgBytes: 512 * 1024,
});

export const QR_ERROR_CORRECTION_LEVELS = ["L", "M", "Q", "H"] as const;
export type QrErrorCorrectionLevel =
  (typeof QR_ERROR_CORRECTION_LEVELS)[number];

export const QR_ECC_BYTE_CAPACITY: Readonly<
  Record<QrErrorCorrectionLevel, number>
> = Object.freeze({ L: 2_953, M: 2_331, Q: 1_663, H: 1_273 });

export const QR_DISPLAY_SIZES = [256, 512, 1024] as const;
export type QrDisplaySize = (typeof QR_DISPLAY_SIZES)[number];

export const QR_INVERSION_ATTEMPTS = ["dontInvert", "attemptBoth"] as const;
export type QrInversionAttempts = (typeof QR_INVERSION_ATTEMPTS)[number];

export interface QrGenerateInput {
  readonly mode: "generate";
  readonly text: string;
  readonly ecc: QrErrorCorrectionLevel;
  readonly displaySize: QrDisplaySize;
}

export interface QrScanInput {
  readonly mode: "scan";
  readonly rgba: ArrayBuffer;
  readonly width: number;
  readonly height: number;
  readonly inversionAttempts: QrInversionAttempts;
}

export type QrWorkerInput = QrGenerateInput | QrScanInput;

export type QrCodeErrorCode =
  | "invalid-input"
  | "empty-input"
  | "text-too-large"
  | "capacity-exceeded"
  | "invalid-dimensions"
  | "too-many-pixels"
  | "invalid-rgba-length"
  | "not-found"
  | "output-too-large"
  | "generation-failed"
  | "scan-failed";

export interface QrCodeError {
  readonly code: QrCodeErrorCode;
  readonly message: string;
  readonly field?: "text" | "ecc" | "displaySize" | "image";
  readonly actual?: number;
  readonly limit?: number;
}

export interface QrGenerateSuccess {
  readonly ok: true;
  readonly mode: "generate";
  readonly svg: string;
  readonly version: number;
  readonly modules: number;
  readonly ecc: QrErrorCorrectionLevel;
  readonly displaySize: QrDisplaySize;
  readonly textBytes: number;
  readonly outputBytes: number;
}

export interface QrScanSuccess {
  readonly ok: true;
  readonly mode: "scan";
  readonly text: string;
  readonly textBytes: number;
  readonly version: number;
}

export interface QrCodeFailure {
  readonly ok: false;
  readonly error: QrCodeError;
}

export type QrCodeResult = QrGenerateSuccess | QrScanSuccess | QrCodeFailure;

export const QR_WORKER_PROTOCOL_VERSION = 1 as const;

export interface QrWorkerExecuteMessage {
  readonly type: "QR_CODE_EXECUTE";
  readonly protocol: typeof QR_WORKER_PROTOCOL_VERSION;
  readonly taskId: string;
  readonly input: QrWorkerInput;
}

export interface QrWorkerResultMessage {
  readonly type: "QR_CODE_RESULT";
  readonly protocol: typeof QR_WORKER_PROTOCOL_VERSION;
  readonly taskId: string;
  readonly result: QrCodeResult;
}

const encoder = new TextEncoder();
const taskIdPattern = /^qr-[A-Za-z0-9_-]{1,96}$/u;
const errorCodes = new Set<QrCodeErrorCode>([
  "invalid-input",
  "empty-input",
  "text-too-large",
  "capacity-exceeded",
  "invalid-dimensions",
  "too-many-pixels",
  "invalid-rgba-length",
  "not-found",
  "output-too-large",
  "generation-failed",
  "scan-failed",
]);
const errorFields = new Set<NonNullable<QrCodeError["field"]>>([
  "text",
  "ecc",
  "displaySize",
  "image",
]);

export function getQrTextByteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

export function calculateQrScanDimensions(
  width: number,
  height: number,
): {
  readonly width: number;
  readonly height: number;
  readonly resized: boolean;
} {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return { width: 0, height: 0, resized: false };
  }
  const pixels = width * height;
  if (pixels <= QR_CODE_LIMITS.maxScanPixels) {
    return { width, height, resized: false };
  }
  const scale = Math.sqrt(QR_CODE_LIMITS.maxScanPixels / pixels);
  let targetWidth = Math.max(1, Math.floor(width * scale));
  let targetHeight = Math.max(1, Math.floor(height * scale));
  while (targetWidth * targetHeight > QR_CODE_LIMITS.maxScanPixels) {
    if (targetWidth >= targetHeight) targetWidth -= 1;
    else targetHeight -= 1;
  }
  return { width: targetWidth, height: targetHeight, resized: true };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  try {
    return Reflect.ownKeys(value).every((key) => {
      if (typeof key !== "string" || !allowed.includes(key)) return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return Boolean(
        descriptor?.enumerable &&
        Object.prototype.hasOwnProperty.call(descriptor, "value"),
      );
    });
  } catch {
    return false;
  }
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  try {
    return (
      hasOnlyKeys(value, expected) &&
      Reflect.ownKeys(value).length === expected.length
    );
  } catch {
    return false;
  }
}

function ownDataValue(value: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function isSafeCount(value: unknown, maximum = Number.MAX_SAFE_INTEGER) {
  return (
    Number.isSafeInteger(value) &&
    Number(value) >= 0 &&
    Number(value) <= maximum
  );
}

function isQrCodeError(value: unknown): value is QrCodeError {
  if (!isPlainRecord(value)) return false;
  if (!hasOnlyKeys(value, ["code", "message", "field", "actual", "limit"])) {
    return false;
  }
  const code = ownDataValue(value, "code");
  const message = ownDataValue(value, "message");
  const field = ownDataValue(value, "field");
  const actual = ownDataValue(value, "actual");
  const limit = ownDataValue(value, "limit");
  return (
    typeof code === "string" &&
    errorCodes.has(code as QrCodeErrorCode) &&
    typeof message === "string" &&
    message.length > 0 &&
    message.length <= 256 &&
    (field === undefined ||
      errorFields.has(field as NonNullable<QrCodeError["field"]>)) &&
    (actual === undefined || isSafeCount(actual)) &&
    (limit === undefined || isSafeCount(limit))
  );
}

function isFixedQrSvg(
  value: string,
  displaySize: QrDisplaySize,
  modules: number,
): boolean {
  const prefix = `<svg xmlns="http://www.w3.org/2000/svg" width="${displaySize}" height="${displaySize}" viewBox="0 0 ${modules} ${modules}" shape-rendering="crispEdges"><rect width="${modules}" height="${modules}" fill="#ffffff"/><path d="`;
  const suffix = '" fill="#0f172a"/></svg>';
  if (!value.startsWith(prefix) || !value.endsWith(suffix)) return false;
  const commands = value.slice(prefix.length, -suffix.length);
  if (!/^(?:M\d{1,3},\d{1,3}h1v1h-1z)*$/u.test(commands)) return false;

  for (const match of commands.matchAll(/M(\d{1,3}),(\d{1,3})h1v1h-1z/gu)) {
    if (Number(match[1]) >= modules || Number(match[2]) >= modules)
      return false;
  }
  return true;
}

export function isQrCodeResult(value: unknown): value is QrCodeResult {
  try {
    return validateQrCodeResult(value);
  } catch {
    return false;
  }
}

function validateQrCodeResult(value: unknown): value is QrCodeResult {
  if (!isPlainRecord(value)) return false;

  if (hasExactKeys(value, ["ok", "error"])) {
    return (
      ownDataValue(value, "ok") === false &&
      isQrCodeError(ownDataValue(value, "error"))
    );
  }

  if (
    hasExactKeys(value, [
      "ok",
      "mode",
      "svg",
      "version",
      "modules",
      "ecc",
      "displaySize",
      "textBytes",
      "outputBytes",
    ])
  ) {
    const ok = ownDataValue(value, "ok");
    const mode = ownDataValue(value, "mode");
    const svg = ownDataValue(value, "svg");
    const version = ownDataValue(value, "version");
    const modules = ownDataValue(value, "modules");
    const ecc = ownDataValue(value, "ecc");
    const displaySize = ownDataValue(value, "displaySize");
    const textBytes = ownDataValue(value, "textBytes");
    const outputBytes = ownDataValue(value, "outputBytes");
    if (
      ok !== true ||
      mode !== "generate" ||
      typeof svg !== "string" ||
      !isSafeCount(version, 40) ||
      Number(version) < 1 ||
      !isSafeCount(modules, 185) ||
      Number(modules) !== 17 + Number(version) * 4 + 8 ||
      !QR_ERROR_CORRECTION_LEVELS.includes(ecc as QrErrorCorrectionLevel) ||
      !QR_DISPLAY_SIZES.includes(displaySize as QrDisplaySize) ||
      !isSafeCount(textBytes, QR_CODE_LIMITS.maxTextBytes) ||
      !isSafeCount(outputBytes, QR_CODE_LIMITS.maxSvgBytes) ||
      Number(outputBytes) !== getQrTextByteLength(svg)
    ) {
      return false;
    }
    return isFixedQrSvg(svg, displaySize as QrDisplaySize, Number(modules));
  }

  if (hasExactKeys(value, ["ok", "mode", "text", "textBytes", "version"])) {
    const ok = ownDataValue(value, "ok");
    const mode = ownDataValue(value, "mode");
    const text = ownDataValue(value, "text");
    const textBytes = ownDataValue(value, "textBytes");
    const version = ownDataValue(value, "version");
    return (
      ok === true &&
      mode === "scan" &&
      typeof text === "string" &&
      isSafeCount(textBytes, QR_CODE_LIMITS.maxDecodedTextBytes) &&
      Number(textBytes) === getQrTextByteLength(text) &&
      isSafeCount(version, 40) &&
      Number(version) >= 1
    );
  }
  return false;
}

export function isQrWorkerResultMessage(
  value: unknown,
  expectedTaskId: string,
): value is QrWorkerResultMessage {
  try {
    if (
      !isPlainRecord(value) ||
      !hasExactKeys(value, ["type", "protocol", "taskId", "result"])
    ) {
      return false;
    }
    return (
      ownDataValue(value, "type") === "QR_CODE_RESULT" &&
      ownDataValue(value, "protocol") === QR_WORKER_PROTOCOL_VERSION &&
      ownDataValue(value, "taskId") === expectedTaskId &&
      isQrCodeResult(ownDataValue(value, "result"))
    );
  } catch {
    return false;
  }
}

export function isQrWorkerExecuteMessage(
  value: unknown,
): value is QrWorkerExecuteMessage {
  try {
    return validateQrWorkerExecuteMessage(value);
  } catch {
    return false;
  }
}

function validateQrWorkerExecuteMessage(
  value: unknown,
): value is QrWorkerExecuteMessage {
  if (!isPlainRecord(value)) return false;
  if (!hasExactKeys(value, ["type", "protocol", "taskId", "input"])) {
    return false;
  }
  const type = ownDataValue(value, "type");
  const protocol = ownDataValue(value, "protocol");
  const taskId = ownDataValue(value, "taskId");
  const input = ownDataValue(value, "input");
  if (
    type !== "QR_CODE_EXECUTE" ||
    protocol !== QR_WORKER_PROTOCOL_VERSION ||
    typeof taskId !== "string" ||
    !taskIdPattern.test(taskId) ||
    !isPlainRecord(input)
  ) {
    return false;
  }

  if (hasExactKeys(input, ["mode", "text", "ecc", "displaySize"])) {
    const mode = ownDataValue(input, "mode");
    const text = ownDataValue(input, "text");
    const ecc = ownDataValue(input, "ecc");
    const displaySize = ownDataValue(input, "displaySize");
    return (
      mode === "generate" &&
      typeof text === "string" &&
      text.length <= QR_CODE_LIMITS.maxTextBytes &&
      getQrTextByteLength(text) <= QR_CODE_LIMITS.maxTextBytes &&
      QR_ERROR_CORRECTION_LEVELS.includes(ecc as QrErrorCorrectionLevel) &&
      QR_DISPLAY_SIZES.includes(displaySize as QrDisplaySize)
    );
  }

  if (
    !hasExactKeys(input, [
      "mode",
      "rgba",
      "width",
      "height",
      "inversionAttempts",
    ])
  ) {
    return false;
  }
  const mode = ownDataValue(input, "mode");
  const rgba = ownDataValue(input, "rgba");
  const width = ownDataValue(input, "width");
  const height = ownDataValue(input, "height");
  const inversionAttempts = ownDataValue(input, "inversionAttempts");
  if (
    mode !== "scan" ||
    !(rgba instanceof ArrayBuffer) ||
    !isSafeCount(width, QR_CODE_LIMITS.maxSourceEdge) ||
    !isSafeCount(height, QR_CODE_LIMITS.maxSourceEdge) ||
    Number(width) < 1 ||
    Number(height) < 1 ||
    !QR_INVERSION_ATTEMPTS.includes(inversionAttempts as QrInversionAttempts)
  ) {
    return false;
  }
  const pixels = Number(width) * Number(height);
  return (
    Number.isSafeInteger(pixels) &&
    pixels <= QR_CODE_LIMITS.maxScanPixels &&
    rgba.byteLength === pixels * 4
  );
}

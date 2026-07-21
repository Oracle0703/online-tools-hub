import type {
  BinaryOperationInput,
  BinaryOperationOutput,
  EmptyOperationInput,
  OperationInput,
  OperationPayload,
  RgbaImageOperationInput,
  TextOperationInput,
  TextOperationOutput,
  TextPairOperationInput,
} from "../operations/contract";

export const DEFAULT_PAYLOAD_VAULT_MAX_BYTES = 256 * 1024 * 1024;
export const DEFAULT_PAYLOAD_VAULT_MAX_ENTRIES = 64;
export const DEFAULT_TEXT_PREVIEW_MAX_BYTES = 32 * 1024;

declare const payloadIdBrand: unique symbol;
export type PayloadId = string & { readonly [payloadIdBrand]: true };

export type VaultPayload =
  | EmptyOperationInput
  | TextOperationInput
  | TextOperationOutput
  | TextPairOperationInput
  | BinaryOperationInput
  | BinaryOperationOutput
  | RgbaImageOperationInput;

export type PayloadHandle = Readonly<{
  id: PayloadId;
  kind: VaultPayload["kind"];
  semanticType: string;
  bytes: number;
}>;

export type PayloadMetadata = PayloadHandle &
  Readonly<{
    mimeType?: string;
    width?: number;
    height?: number;
  }>;

export type PayloadPreview =
  | Readonly<{
      id: PayloadId;
      kind: "empty";
      semanticType: string;
      bytes: 0;
    }>
  | Readonly<{
      id: PayloadId;
      kind: "text";
      semanticType: string;
      bytes: number;
      text: string;
      truncated: boolean;
    }>
  | Readonly<{
      id: PayloadId;
      kind: "text-pair";
      semanticType: string;
      bytes: number;
      left: string;
      right: string;
      truncated: boolean;
    }>
  | Readonly<{
      id: PayloadId;
      kind: "binary";
      semanticType: string;
      bytes: number;
      mimeType?: string;
    }>
  | Readonly<{
      id: PayloadId;
      kind: "rgba-image";
      semanticType: string;
      bytes: number;
      width: number;
      height: number;
    }>;

export type PayloadVaultSnapshot = Readonly<{
  entries: number;
  bytes: number;
  disposed: boolean;
  objectUrls: number;
}>;

export type PayloadVaultErrorCode =
  | "invalid-payload"
  | "entry-limit"
  | "memory-budget"
  | "unknown-payload"
  | "disposed"
  | "id-collision";

export class PayloadVaultError extends Error {
  readonly code: PayloadVaultErrorCode;

  constructor(code: PayloadVaultErrorCode, message: string) {
    super(message);
    this.name = "PayloadVaultError";
    this.code = code;
  }
}

export interface PayloadVaultOptions {
  readonly maxBytes?: number;
  readonly maxEntries?: number;
  /** Injectable only so deterministic tests do not weaken production IDs. */
  readonly idFactory?: () => string;
  readonly revokeObjectUrl?: (url: string) => void;
}

type StoredPayload =
  | Readonly<{ kind: "empty" }>
  | Readonly<{ kind: "text"; text: string }>
  | Readonly<{ kind: "text-pair"; left: string; right: string }>
  | Readonly<{ kind: "binary"; data: ArrayBuffer; mimeType?: string }>
  | Readonly<{
      kind: "rgba-image";
      width: number;
      height: number;
      data: Uint8ClampedArray;
    }>;

type VaultEntry = Readonly<{
  id: PayloadId;
  semanticType: string;
  bytes: number;
  payload: StoredPayload;
}>;

const PAYLOAD_ID_PATTERN = /^[A-Za-z0-9_-]{8,256}$/;
const SEMANTIC_TYPE_PATTERN = /^[a-z0-9]+(?:[./+_-][a-z0-9]+)*$/;
const MIME_TYPE_PATTERN =
  /^[a-z0-9][a-z0-9!#$&^_.+-]{0,62}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;

function invalidPayload(message: string): never {
  throw new PayloadVaultError("invalid-payload", message);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function readDataProperties(
  value: unknown,
  allowed: ReadonlySet<string>,
): Record<string, unknown> {
  if (!isPlainRecord(value)) invalidPayload("Payload must be a plain object.");

  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      invalidPayload("Payload contains an unsupported field.");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      invalidPayload("Payload must contain only enumerable data properties.");
    }
  }

  return value;
}

function utf8BytesForCodePoint(codePoint: number): number {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  return codePoint <= 0xffff ? 3 : 4;
}

/**
 * Strings occupy UTF-16 memory in JavaScript, but their encoded form can be
 * larger. Charging the larger representation prevents either class of text
 * from slipping under the in-memory budget.
 */
export function textMemoryByteLength(text: string): number {
  let utf8Bytes = 0;
  for (const character of text) {
    utf8Bytes += utf8BytesForCodePoint(character.codePointAt(0) ?? 0xfffd);
  }
  return Math.max(utf8Bytes, text.length * 2);
}

function textPreview(text: string, maxBytes: number): string {
  if (maxBytes <= 0 || text.length === 0) return "";

  let bytes = 0;
  let end = 0;
  for (const character of text) {
    const nextBytes = Math.max(
      utf8BytesForCodePoint(character.codePointAt(0) ?? 0xfffd),
      character.length * 2,
    );
    if (bytes + nextBytes > maxBytes) break;
    bytes += nextBytes;
    end += character.length;
  }
  return text.slice(0, end);
}

function isSharedArrayBuffer(value: unknown): boolean {
  return (
    typeof SharedArrayBuffer !== "undefined" &&
    value instanceof SharedArrayBuffer
  );
}

function assertFitsAvailableBudget(
  bytes: number,
  availableBytes: number,
): void {
  if (bytes > availableBytes) {
    throw new PayloadVaultError(
      "memory-budget",
      "Payload would exceed the Payload Vault memory budget.",
    );
  }
}

function copyArrayBuffer(value: unknown, availableBytes: number): ArrayBuffer {
  if (isSharedArrayBuffer(value) || !(value instanceof ArrayBuffer)) {
    invalidPayload("Binary payload data must be an ArrayBuffer.");
  }

  let view: Uint8Array;
  try {
    // Construction detects detached buffers, including detached zero-length
    // buffers which cannot be distinguished by byteLength alone.
    view = new Uint8Array(value);
  } catch {
    invalidPayload("Binary payload data must not be detached.");
  }
  assertFitsAvailableBudget(view.byteLength, availableBytes);
  return view.slice().buffer;
}

function copyRgbaData(
  value: unknown,
  expectedBytes: number,
  availableBytes: number,
): Uint8ClampedArray {
  if (!(value instanceof Uint8ClampedArray)) {
    invalidPayload("RGBA data must be a Uint8ClampedArray.");
  }
  if (isSharedArrayBuffer(value.buffer)) {
    invalidPayload("RGBA data must not use SharedArrayBuffer.");
  }
  if (value.byteLength !== expectedBytes) {
    invalidPayload("RGBA data length does not match its dimensions.");
  }
  assertFitsAvailableBudget(value.byteLength, availableBytes);

  try {
    return value.slice();
  } catch {
    invalidPayload("RGBA data must not be detached.");
  }
}

function validateMimeType(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !MIME_TYPE_PATTERN.test(value)) {
    invalidPayload("Binary mimeType must be a lowercase media type.");
  }
  return value;
}

function validateDimension(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    invalidPayload(`RGBA ${name} must be a positive safe integer.`);
  }
  return value as number;
}

function copyForStorage(
  payload: unknown,
  availableBytes: number,
): {
  payload: StoredPayload;
  bytes: number;
} {
  if (!isPlainRecord(payload))
    invalidPayload("Payload must be a plain object.");
  const kindDescriptor = Object.getOwnPropertyDescriptor(payload, "kind");
  if (!kindDescriptor?.enumerable || !("value" in kindDescriptor)) {
    invalidPayload("Payload kind must be an enumerable data property.");
  }

  switch (kindDescriptor.value) {
    case "empty": {
      readDataProperties(payload, new Set(["kind"]));
      return { payload: Object.freeze({ kind: "empty" }), bytes: 0 };
    }
    case "text": {
      const record = readDataProperties(payload, new Set(["kind", "text"]));
      if (typeof record.text !== "string") {
        invalidPayload("Text payload must contain a string.");
      }
      const bytes = textMemoryByteLength(record.text);
      assertFitsAvailableBudget(bytes, availableBytes);
      return {
        payload: Object.freeze({ kind: "text", text: record.text }),
        bytes,
      };
    }
    case "text-pair": {
      const record = readDataProperties(
        payload,
        new Set(["kind", "left", "right"]),
      );
      if (typeof record.left !== "string" || typeof record.right !== "string") {
        invalidPayload("Text-pair payload must contain two strings.");
      }
      const bytes =
        textMemoryByteLength(record.left) + textMemoryByteLength(record.right);
      assertFitsAvailableBudget(bytes, availableBytes);
      return {
        payload: Object.freeze({
          kind: "text-pair",
          left: record.left,
          right: record.right,
        }),
        bytes,
      };
    }
    case "binary": {
      const record = readDataProperties(
        payload,
        new Set(["kind", "data", "mimeType"]),
      );
      const data = copyArrayBuffer(record.data, availableBytes);
      const mimeType = validateMimeType(record.mimeType);
      return {
        payload: Object.freeze({
          kind: "binary",
          data,
          ...(mimeType === undefined ? {} : { mimeType }),
        }),
        bytes: data.byteLength,
      };
    }
    case "rgba-image": {
      const record = readDataProperties(
        payload,
        new Set(["kind", "width", "height", "data"]),
      );
      const width = validateDimension(record.width, "width");
      const height = validateDimension(record.height, "height");
      const expectedBytes = width * height * 4;
      if (!Number.isSafeInteger(expectedBytes)) {
        invalidPayload("RGBA dimensions exceed the safe integer range.");
      }
      const data = copyRgbaData(record.data, expectedBytes, availableBytes);
      return {
        payload: Object.freeze({ kind: "rgba-image", width, height, data }),
        bytes: data.byteLength,
      };
    }
    default:
      invalidPayload(
        "Payload kind must be empty, text, text-pair, binary or rgba-image.",
      );
  }
}

function copyForMaterialization(payload: StoredPayload): VaultPayload {
  switch (payload.kind) {
    case "empty":
      return { kind: "empty" };
    case "text":
      return { kind: "text", text: payload.text };
    case "text-pair":
      return { kind: "text-pair", left: payload.left, right: payload.right };
    case "binary":
      return {
        kind: "binary",
        data: payload.data.slice(0),
        ...(payload.mimeType === undefined
          ? {}
          : { mimeType: payload.mimeType }),
      };
    case "rgba-image":
      return {
        kind: "rgba-image",
        width: payload.width,
        height: payload.height,
        data: payload.data.slice(),
      };
  }
}

function defaultIdFactory(): string {
  if (typeof globalThis.crypto?.randomUUID !== "function") {
    throw new PayloadVaultError(
      "id-collision",
      "A cryptographically random payload ID generator is unavailable.",
    );
  }
  return globalThis.crypto.randomUUID();
}

function assertPositiveLimit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
  return value;
}

/**
 * Per-tab, memory-only ownership boundary for workflow payload bodies.
 * Handles and snapshots are deliberately insufficient to recover content.
 */
export class PayloadVault {
  readonly #entries = new Map<PayloadId, VaultEntry>();
  readonly #objectUrls = new Map<string, PayloadId | undefined>();
  readonly #maxBytes: number;
  readonly #maxEntries: number;
  readonly #idFactory: () => string;
  readonly #revokeObjectUrl: (url: string) => void;
  #bytes = 0;
  #disposed = false;

  constructor(options: PayloadVaultOptions = {}) {
    this.#maxBytes = assertPositiveLimit(
      options.maxBytes ?? DEFAULT_PAYLOAD_VAULT_MAX_BYTES,
      "maxBytes",
    );
    this.#maxEntries = assertPositiveLimit(
      options.maxEntries ?? DEFAULT_PAYLOAD_VAULT_MAX_ENTRIES,
      "maxEntries",
    );
    this.#idFactory = options.idFactory ?? defaultIdFactory;
    this.#revokeObjectUrl =
      options.revokeObjectUrl ??
      ((url) => {
        if (typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(url);
      });
  }

  put(payload: VaultPayload, semanticType: string): PayloadHandle {
    this.#assertActive();
    if (
      typeof semanticType !== "string" ||
      semanticType.length > 128 ||
      !SEMANTIC_TYPE_PATTERN.test(semanticType)
    ) {
      invalidPayload("semanticType must be a safe lowercase identifier.");
    }
    if (this.#entries.size >= this.#maxEntries) {
      throw new PayloadVaultError(
        "entry-limit",
        `Payload Vault is limited to ${this.#maxEntries} entries.`,
      );
    }

    const stored = copyForStorage(payload, this.#maxBytes - this.#bytes);

    const id = this.#createId();
    const entry = Object.freeze({
      id,
      semanticType,
      bytes: stored.bytes,
      payload: stored.payload,
    });
    this.#entries.set(id, entry);
    this.#bytes += stored.bytes;
    return Object.freeze({
      id,
      kind: stored.payload.kind,
      semanticType,
      bytes: stored.bytes,
    });
  }

  has(id: PayloadId | string): boolean {
    return !this.#disposed && this.#entries.has(id as PayloadId);
  }

  metadata(id: PayloadId | string): PayloadMetadata {
    const entry = this.#get(id);
    const base = {
      id: entry.id,
      kind: entry.payload.kind,
      semanticType: entry.semanticType,
      bytes: entry.bytes,
    };
    switch (entry.payload.kind) {
      case "empty":
        return Object.freeze(base);
      case "text":
        return Object.freeze(base);
      case "text-pair":
        return Object.freeze(base);
      case "binary":
        return Object.freeze({
          ...base,
          ...(entry.payload.mimeType === undefined
            ? {}
            : { mimeType: entry.payload.mimeType }),
        });
      case "rgba-image":
        return Object.freeze({
          ...base,
          width: entry.payload.width,
          height: entry.payload.height,
        });
    }
  }

  materialize(id: PayloadId | string): OperationPayload {
    return copyForMaterialization(this.#get(id).payload);
  }

  /** Materializes an Executor-safe input envelope without output-only fields. */
  materializeInput(id: PayloadId | string): OperationInput {
    const payload = copyForMaterialization(this.#get(id).payload);
    if (payload.kind !== "binary") return payload;
    return { kind: "binary", data: payload.data };
  }

  preview(
    id: PayloadId | string,
    maxTextBytes = DEFAULT_TEXT_PREVIEW_MAX_BYTES,
  ): PayloadPreview {
    if (!Number.isSafeInteger(maxTextBytes) || maxTextBytes < 0) {
      throw new RangeError("maxTextBytes must be a non-negative safe integer.");
    }
    const entry = this.#get(id);
    switch (entry.payload.kind) {
      case "empty":
        return Object.freeze({
          id: entry.id,
          kind: "empty",
          semanticType: entry.semanticType,
          bytes: 0,
        });
      case "text": {
        const text = textPreview(entry.payload.text, maxTextBytes);
        return Object.freeze({
          id: entry.id,
          kind: "text",
          semanticType: entry.semanticType,
          bytes: entry.bytes,
          text,
          truncated: text.length < entry.payload.text.length,
        });
      }
      case "text-pair": {
        const leftBudget = Math.floor(maxTextBytes / 2);
        const rightBudget = maxTextBytes - leftBudget;
        const left = textPreview(entry.payload.left, leftBudget);
        const right = textPreview(entry.payload.right, rightBudget);
        return Object.freeze({
          id: entry.id,
          kind: "text-pair",
          semanticType: entry.semanticType,
          bytes: entry.bytes,
          left,
          right,
          truncated:
            left.length < entry.payload.left.length ||
            right.length < entry.payload.right.length,
        });
      }
      case "binary":
        return Object.freeze({
          id: entry.id,
          kind: "binary",
          semanticType: entry.semanticType,
          bytes: entry.bytes,
          ...(entry.payload.mimeType === undefined
            ? {}
            : { mimeType: entry.payload.mimeType }),
        });
      case "rgba-image":
        return Object.freeze({
          id: entry.id,
          kind: "rgba-image",
          semanticType: entry.semanticType,
          bytes: entry.bytes,
          width: entry.payload.width,
          height: entry.payload.height,
        });
    }
  }

  /**
   * Tracks a URL created by a caller so lifecycle cleanup remains central.
   * Associating a payload handle also revokes the URL when that entry is
   * deleted; callers that do not yet have a handle may omit it.
   */
  registerObjectUrl(url: string, payloadId?: PayloadId | string): void {
    this.#assertActive();
    if (typeof url !== "string" || !url.startsWith("blob:")) {
      throw new TypeError("Object URL must use the blob: scheme.");
    }
    const associatedId =
      payloadId === undefined ? undefined : this.#get(payloadId).id;
    this.#objectUrls.set(url, associatedId);
  }

  /** Revokes a tracked URL once; returns whether it was registered. */
  revokeObjectUrl(url: string): boolean {
    if (!this.#objectUrls.delete(url)) return false;
    this.#safeRevoke(url);
    return true;
  }

  delete(id: PayloadId | string): boolean {
    if (this.#disposed) return false;
    const entry = this.#entries.get(id as PayloadId);
    if (entry === undefined) return false;
    this.#entries.delete(entry.id);
    this.#bytes -= entry.bytes;
    for (const [url, associatedId] of this.#objectUrls) {
      if (associatedId === entry.id) this.revokeObjectUrl(url);
    }
    return true;
  }

  clear(): void {
    if (this.#disposed) return;
    this.#entries.clear();
    this.#bytes = 0;
    this.#revokeAllObjectUrls();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.clear();
    this.#disposed = true;
  }

  snapshot(): PayloadVaultSnapshot {
    return Object.freeze({
      entries: this.#entries.size,
      bytes: this.#bytes,
      disposed: this.#disposed,
      objectUrls: this.#objectUrls.size,
    });
  }

  #assertActive(): void {
    if (this.#disposed) {
      throw new PayloadVaultError("disposed", "Payload Vault is disposed.");
    }
  }

  #get(id: PayloadId | string): VaultEntry {
    this.#assertActive();
    const entry = this.#entries.get(id as PayloadId);
    if (entry === undefined) {
      throw new PayloadVaultError("unknown-payload", "Payload does not exist.");
    }
    return entry;
  }

  #createId(): PayloadId {
    const candidate = this.#idFactory();
    if (typeof candidate !== "string" || !PAYLOAD_ID_PATTERN.test(candidate)) {
      throw new PayloadVaultError(
        "id-collision",
        "Payload ID generator returned an invalid opaque ID.",
      );
    }
    const id = candidate as PayloadId;
    if (this.#entries.has(id)) {
      throw new PayloadVaultError(
        "id-collision",
        "Payload ID generator returned a duplicate ID.",
      );
    }
    return id;
  }

  #revokeAllObjectUrls(): void {
    const urls = [...this.#objectUrls.keys()];
    this.#objectUrls.clear();
    for (const url of urls) this.#safeRevoke(url);
  }

  #safeRevoke(url: string): void {
    try {
      this.#revokeObjectUrl(url);
    } catch {
      // Cleanup must stay idempotent even when a host URL implementation fails.
    }
  }
}

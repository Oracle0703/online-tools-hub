import { getOperationManifest } from "../operations/catalog";
import type { WorkflowRecipeV1 } from "../workflows/contract";
import { compileWorkflowCandidate } from "../workflows/planner";
import { exportWorkflowRecipeCanonical } from "../workflows/recipe-codec";

export const WORKFLOW_RECIPE_LIBRARY_FORMAT =
  "online-tools-hub/workflow-recipe-library" as const;
export const WORKFLOW_RECIPE_LIBRARY_VERSION = 1 as const;
export const WORKFLOW_RECIPE_LIBRARY_STORAGE_KEY =
  "online-tools-hub:workflow-recipe-library:v1" as const;
export const MAX_WORKFLOW_RECIPE_LIBRARY_ENTRIES = 20;
export const MAX_WORKFLOW_RECIPE_LIBRARY_CANONICAL_BYTES = 512 * 1024;

const MAX_WORKFLOW_RECIPE_LIBRARY_STORAGE_BYTES =
  MAX_WORKFLOW_RECIPE_LIBRARY_CANONICAL_BYTES + 32 * 1024;
const RECIPE_ENTRY_ID_PATTERN = /^recipe-[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const MAX_RECIPE_ENTRY_ID_LENGTH = 96;
const ENVELOPE_KEYS = new Set(["format", "version", "items"]);
const STORED_ENTRY_KEYS = new Set(["id", "updatedAt", "recipe"]);

export type WorkflowRecipeLibraryPersistenceReason =
  | "storage-unavailable"
  | "storage-read-failed"
  | "invalid-storage"
  | "storage-write-failed"
  | "storage-write-conflict";

export type WorkflowRecipeLibraryErrorCode =
  | "library-full"
  | "library-too-large"
  | "id-unavailable"
  | "unsafe-configuration";

export class WorkflowRecipeLibraryError extends Error {
  readonly code: WorkflowRecipeLibraryErrorCode;

  constructor(code: WorkflowRecipeLibraryErrorCode) {
    super(
      code === "library-full"
        ? "The local recipe library is full."
        : code === "library-too-large"
          ? "The local recipe library exceeds its size limit."
          : code === "id-unavailable"
            ? "A safe recipe identifier could not be generated."
            : "The recipe contains a free-text option that is not safe to persist.",
    );
    this.name = "WorkflowRecipeLibraryError";
    this.code = code;
  }
}

export interface WorkflowRecipeLibraryEntry {
  readonly id: string;
  readonly updatedAt: number;
  /** Derived from the Operation chain and never persisted in the envelope. */
  readonly name: string;
  readonly recipe: WorkflowRecipeV1;
  /** Canonical recipe wire format, derived again after every storage read. */
  readonly canonical: string;
  readonly canonicalBytes: number;
}

export interface WorkflowRecipeLibrarySnapshot {
  readonly entries: readonly WorkflowRecipeLibraryEntry[];
  readonly canonicalBytes: number;
  /** True only when this exact snapshot is known to match localStorage. */
  readonly persisted: boolean;
  readonly reason?: WorkflowRecipeLibraryPersistenceReason;
}

export interface WorkflowRecipeLibraryMutationResult {
  readonly snapshot: WorkflowRecipeLibrarySnapshot;
  readonly persisted: boolean;
  readonly reason?: WorkflowRecipeLibraryPersistenceReason;
  readonly entry?: WorkflowRecipeLibraryEntry;
}

export type WorkflowRecipeLibraryStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem"
>;

export type WorkflowRecipeLibraryEventTarget = Pick<
  EventTarget,
  "addEventListener" | "removeEventListener"
>;

export interface WorkflowRecipeLibraryStoreOptions {
  /** `undefined` resolves browser localStorage; `null` forces memory-only. */
  readonly storage?: WorkflowRecipeLibraryStorage | null;
  /** `undefined` resolves window; `null` disables StorageEvent listening. */
  readonly eventTarget?: WorkflowRecipeLibraryEventTarget | null;
  readonly now?: () => number;
  readonly createId?: () => string;
}

type StoredEntry = Readonly<{
  id: string;
  updatedAt: number;
  recipe: WorkflowRecipeV1;
}>;

type StorageEventShape = Event & {
  readonly key?: string | null;
  readonly storageArea?: Storage | null;
};

const textEncoder = new TextEncoder();
let fallbackIdSequence = 0;

function utf8ByteLength(value: string): number {
  return textEncoder.encode(value).byteLength;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactDataKeys(
  value: unknown,
  expectedKeys: ReadonlySet<string>,
): value is Record<string, unknown> {
  if (!isPlainRecord(value)) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expectedKeys.size) return false;
  for (const key of keys) {
    if (typeof key !== "string" || !expectedKeys.has(key)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !Object.prototype.hasOwnProperty.call(descriptor, "value")
    ) {
      return false;
    }
  }
  return true;
}

function isDenseArray(value: unknown): value is readonly unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  ) {
    return false;
  }
  const length = value.length;
  if (!Number.isSafeInteger(length)) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== length + 1 || !keys.includes("length")) return false;
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !Object.prototype.hasOwnProperty.call(descriptor, "value")
    ) {
      return false;
    }
  }
  return true;
}

function isValidEntryId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_RECIPE_ENTRY_ID_LENGTH &&
    RECIPE_ENTRY_ID_PATTERN.test(value)
  );
}

function isValidTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value >= 0;
}

function sortEntries(
  entries: readonly WorkflowRecipeLibraryEntry[],
): readonly WorkflowRecipeLibraryEntry[] {
  return Object.freeze(
    [...entries].sort(
      (left, right) =>
        right.updatedAt - left.updatedAt ||
        left.id.localeCompare(right.id, "en"),
    ),
  );
}

export function deriveWorkflowRecipeSystemName(
  recipe: WorkflowRecipeV1,
): string {
  return recipe.steps.map((step) => step.operationId).join(" → ");
}

function isSupportedTimeZone(value: string): boolean {
  try {
    return (
      new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions()
        .timeZone.length > 0
    );
  } catch {
    return false;
  }
}

function isSupportedLocale(value: string): boolean {
  try {
    const canonical = Intl.getCanonicalLocales(value);
    if (canonical.length !== 1) return false;
    const normalized = canonical[0];
    if (
      normalized === undefined ||
      normalized.toLowerCase().startsWith("x-") ||
      normalized.toLowerCase().includes("-x-")
    ) {
      return false;
    }
    return (
      Intl.DateTimeFormat.supportedLocalesOf(canonical, {
        localeMatcher: "lookup",
      }).length === 1
    );
  } catch {
    return false;
  }
}

const persistableStringOptionValidators = new Map<
  string,
  (value: string) => boolean
>([
  ["timestamp.convert:timeZone", isSupportedTimeZone],
  ["timestamp.convert:locale", isSupportedLocale],
]);

/**
 * Enum strings are already catalog-closed. Free string schemas fail closed at
 * the persistence boundary unless a semantic validator proves that the value
 * is standardized configuration rather than arbitrary user text.
 */
function assertPersistableRecipeConfiguration(recipe: WorkflowRecipeV1): void {
  for (const step of recipe.steps) {
    const manifest = getOperationManifest(step.operationId);
    if (manifest === undefined) {
      throw new WorkflowRecipeLibraryError("unsafe-configuration");
    }
    for (const [name, schema] of Object.entries(manifest.options.properties)) {
      if (schema.type !== "string") continue;
      const value = step.options[name];
      if (value === null) continue;
      const validator = persistableStringOptionValidators.get(
        `${step.operationId}:${name}`,
      );
      if (typeof value !== "string" || validator?.(value) !== true) {
        throw new WorkflowRecipeLibraryError("unsafe-configuration");
      }
    }
  }
}

function createEntry(
  id: string,
  updatedAt: number,
  candidate: unknown,
): WorkflowRecipeLibraryEntry {
  const plan = compileWorkflowCandidate(candidate);
  assertPersistableRecipeConfiguration(plan.recipe);
  const canonical = exportWorkflowRecipeCanonical(plan.recipe);
  const canonicalBytes = utf8ByteLength(canonical);
  return Object.freeze({
    id,
    updatedAt,
    name: deriveWorkflowRecipeSystemName(plan.recipe),
    recipe: plan.recipe,
    canonical,
    canonicalBytes,
  });
}

function totalCanonicalBytes(
  entries: readonly WorkflowRecipeLibraryEntry[],
): number {
  return entries.reduce((total, entry) => total + entry.canonicalBytes, 0);
}

function assertLibraryBounds(
  entries: readonly WorkflowRecipeLibraryEntry[],
): void {
  if (entries.length > MAX_WORKFLOW_RECIPE_LIBRARY_ENTRIES) {
    throw new WorkflowRecipeLibraryError("library-full");
  }
  if (
    totalCanonicalBytes(entries) > MAX_WORKFLOW_RECIPE_LIBRARY_CANONICAL_BYTES
  ) {
    throw new WorkflowRecipeLibraryError("library-too-large");
  }
}

function parseStoredEntries(
  serialized: string | null,
): readonly WorkflowRecipeLibraryEntry[] {
  if (serialized === null) return Object.freeze([]);
  if (utf8ByteLength(serialized) > MAX_WORKFLOW_RECIPE_LIBRARY_STORAGE_BYTES) {
    throw new WorkflowRecipeLibraryError("library-too-large");
  }

  const value: unknown = JSON.parse(serialized);
  if (!hasExactDataKeys(value, ENVELOPE_KEYS)) {
    throw new TypeError("Invalid recipe library envelope.");
  }
  if (
    value.format !== WORKFLOW_RECIPE_LIBRARY_FORMAT ||
    value.version !== WORKFLOW_RECIPE_LIBRARY_VERSION ||
    !isDenseArray(value.items) ||
    value.items.length > MAX_WORKFLOW_RECIPE_LIBRARY_ENTRIES
  ) {
    throw new TypeError("Unsupported recipe library envelope.");
  }

  const entries: WorkflowRecipeLibraryEntry[] = [];
  const ids = new Set<string>();
  const canonicals = new Set<string>();
  for (const valueEntry of value.items) {
    if (
      !hasExactDataKeys(valueEntry, STORED_ENTRY_KEYS) ||
      !isValidEntryId(valueEntry.id) ||
      !isValidTimestamp(valueEntry.updatedAt)
    ) {
      throw new TypeError("Invalid recipe library entry.");
    }
    const entry = createEntry(
      valueEntry.id,
      valueEntry.updatedAt,
      valueEntry.recipe,
    );
    if (ids.has(entry.id) || canonicals.has(entry.canonical)) {
      throw new TypeError("Duplicate recipe library entry.");
    }
    ids.add(entry.id);
    canonicals.add(entry.canonical);
    entries.push(entry);
  }
  assertLibraryBounds(entries);
  return sortEntries(entries);
}

function serializeStoredEntries(
  entries: readonly WorkflowRecipeLibraryEntry[],
): string {
  assertLibraryBounds(entries);
  const items: StoredEntry[] = entries.map((entry) =>
    Object.freeze({
      id: entry.id,
      updatedAt: entry.updatedAt,
      recipe: entry.recipe,
    }),
  );
  const serialized = JSON.stringify({
    format: WORKFLOW_RECIPE_LIBRARY_FORMAT,
    version: WORKFLOW_RECIPE_LIBRARY_VERSION,
    items,
  });
  if (utf8ByteLength(serialized) > MAX_WORKFLOW_RECIPE_LIBRARY_STORAGE_BYTES) {
    throw new WorkflowRecipeLibraryError("library-too-large");
  }
  return serialized;
}

function defaultRecipeId(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === "function") {
    return `recipe-${cryptoApi.randomUUID()}`;
  }
  fallbackIdSequence = (fallbackIdSequence + 1) % Number.MAX_SAFE_INTEGER;
  return `recipe-${Date.now().toString(36)}-${fallbackIdSequence.toString(36)}`;
}

function resolveStorage(
  option: WorkflowRecipeLibraryStoreOptions["storage"],
): WorkflowRecipeLibraryStorage | null {
  if (option !== undefined) return option;
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function resolveEventTarget(
  option: WorkflowRecipeLibraryStoreOptions["eventTarget"],
): WorkflowRecipeLibraryEventTarget | null {
  if (option !== undefined) return option;
  return typeof window === "undefined" ? null : window;
}

function normalizeNow(value: number): number {
  return isValidTimestamp(value) ? value : Math.max(0, Math.trunc(Date.now()));
}

function createSnapshot(
  entries: readonly WorkflowRecipeLibraryEntry[],
  persisted: boolean,
  reason?: WorkflowRecipeLibraryPersistenceReason,
): WorkflowRecipeLibrarySnapshot {
  const snapshot: WorkflowRecipeLibrarySnapshot = {
    entries: sortEntries(entries),
    canonicalBytes: totalCanonicalBytes(entries),
    persisted,
    ...(reason === undefined ? {} : { reason }),
  };
  return Object.freeze(snapshot);
}

function createMutationResult(
  snapshot: WorkflowRecipeLibrarySnapshot,
  entry?: WorkflowRecipeLibraryEntry,
  reasonOverride?: WorkflowRecipeLibraryPersistenceReason,
): WorkflowRecipeLibraryMutationResult {
  const reason = reasonOverride ?? snapshot.reason;
  return Object.freeze({
    snapshot,
    persisted: reasonOverride === undefined && snapshot.persisted,
    ...(reason === undefined ? {} : { reason }),
    ...(entry === undefined ? {} : { entry }),
  });
}

type WorkflowRecipeLibraryCommitResult = Readonly<{
  snapshot: WorkflowRecipeLibrarySnapshot;
  /** True when a later writer replaced this exact mutation before verification. */
  conflicted: boolean;
}>;

function sameSnapshot(
  left: WorkflowRecipeLibrarySnapshot,
  right: WorkflowRecipeLibrarySnapshot,
): boolean {
  return (
    left.persisted === right.persisted &&
    left.reason === right.reason &&
    left.canonicalBytes === right.canonicalBytes &&
    left.entries.length === right.entries.length &&
    left.entries.every((entry, index) => {
      const candidate = right.entries[index];
      return (
        candidate !== undefined &&
        entry.id === candidate.id &&
        entry.updatedAt === candidate.updatedAt &&
        entry.canonical === candidate.canonical
      );
    })
  );
}

/**
 * The sole application facade permitted to access recipe-library storage.
 * Invalid external state never replaces the last known-good in-memory snapshot.
 */
export class WorkflowRecipeLibraryStore {
  readonly #storage: WorkflowRecipeLibraryStorage | null;
  readonly #eventTarget: WorkflowRecipeLibraryEventTarget | null;
  readonly #now: () => number;
  readonly #createId: () => string;
  readonly #listeners = new Set<() => void>();
  #snapshot: WorkflowRecipeLibrarySnapshot;
  #memoryOnlyLocked = false;
  #storageInvalid = false;
  #destroyed = false;

  readonly #handleStorage = (event: Event): void => {
    if (this.#destroyed || this.#memoryOnlyLocked) return;
    const storageEvent = event as StorageEventShape;
    if (
      storageEvent.key !== null &&
      storageEvent.key !== WORKFLOW_RECIPE_LIBRARY_STORAGE_KEY
    ) {
      return;
    }
    if (
      storageEvent.storageArea != null &&
      this.#storage != null &&
      storageEvent.storageArea !== this.#storage
    ) {
      return;
    }
    // Storage events may be queued or delivered after a newer write. Read the
    // authoritative current value instead of trusting a potentially stale
    // event.newValue snapshot.
    this.refresh();
  };

  constructor(options: WorkflowRecipeLibraryStoreOptions = {}) {
    this.#storage = resolveStorage(options.storage);
    this.#eventTarget = resolveEventTarget(options.eventTarget);
    this.#now = options.now ?? Date.now;
    this.#createId = options.createId ?? defaultRecipeId;
    this.#snapshot = createSnapshot(
      [],
      false,
      this.#storage === null ? "storage-unavailable" : "storage-read-failed",
    );

    if (this.#storage === null) {
      this.#memoryOnlyLocked = true;
    } else {
      let serialized: string | null;
      try {
        const storage = this.#storage;
        serialized = storage.getItem(WORKFLOW_RECIPE_LIBRARY_STORAGE_KEY);
      } catch {
        serialized = null;
        this.#snapshot = createSnapshot([], false, "storage-read-failed");
        this.#memoryOnlyLocked = true;
      }
      if (!this.#memoryOnlyLocked) {
        try {
          this.#snapshot = createSnapshot(parseStoredEntries(serialized), true);
        } catch {
          this.#storageInvalid = true;
          this.#snapshot = createSnapshot([], false, "invalid-storage");
        }
      }
    }

    this.#eventTarget?.addEventListener("storage", this.#handleStorage);
  }

  getSnapshot = (): WorkflowRecipeLibrarySnapshot => this.#snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  refresh(): WorkflowRecipeLibrarySnapshot {
    if (this.#destroyed || this.#storage === null || this.#memoryOnlyLocked) {
      return this.#snapshot;
    }
    let serialized: string | null;
    try {
      const storage = this.#storage;
      serialized = storage.getItem(WORKFLOW_RECIPE_LIBRARY_STORAGE_KEY);
    } catch {
      this.#markReadFailure("storage-read-failed");
      return this.#snapshot;
    }
    this.#acceptSerializedStorage(serialized);
    return this.#snapshot;
  }

  save(candidate: unknown): WorkflowRecipeLibraryMutationResult {
    const compiled = createEntry("recipe-placeholder", 0, candidate);
    this.refresh();
    const existing = this.#snapshot.entries.find(
      (entry) => entry.canonical === compiled.canonical,
    );
    if (
      existing === undefined &&
      this.#snapshot.entries.length >= MAX_WORKFLOW_RECIPE_LIBRARY_ENTRIES
    ) {
      throw new WorkflowRecipeLibraryError("library-full");
    }

    const id = existing?.id ?? this.#nextId();
    const entry = createEntry(id, normalizeNow(this.#now()), compiled.recipe);
    const entries = [
      entry,
      ...this.#snapshot.entries.filter(
        (candidateEntry) => candidateEntry.id !== id,
      ),
    ];
    assertLibraryBounds(entries);
    const commit = this.#commit(entries, false);
    return createMutationResult(
      commit.snapshot,
      commit.conflicted ? undefined : entry,
      commit.conflicted ? "storage-write-conflict" : undefined,
    );
  }

  load(id: string): WorkflowRecipeV1 | undefined {
    this.refresh();
    return this.#snapshot.entries.find((entry) => entry.id === id)?.recipe;
  }

  copyCanonical(id: string): string | undefined {
    this.refresh();
    return this.#snapshot.entries.find((entry) => entry.id === id)?.canonical;
  }

  delete(id: string): WorkflowRecipeLibraryMutationResult {
    this.refresh();
    const entries = this.#snapshot.entries.filter((entry) => entry.id !== id);
    if (entries.length === this.#snapshot.entries.length) {
      return createMutationResult(this.#snapshot);
    }
    const commit = this.#commit(entries, false);
    return createMutationResult(
      commit.snapshot,
      undefined,
      commit.conflicted ? "storage-write-conflict" : undefined,
    );
  }

  clear(): WorkflowRecipeLibraryMutationResult {
    this.refresh();
    if (this.#snapshot.entries.length === 0 && this.#snapshot.persisted) {
      return createMutationResult(this.#snapshot);
    }
    const commit = this.#commit([], true, true);
    return createMutationResult(
      commit.snapshot,
      undefined,
      commit.conflicted ? "storage-write-conflict" : undefined,
    );
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#listeners.clear();
    this.#eventTarget?.removeEventListener("storage", this.#handleStorage);
  }

  #nextId(): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const id = this.#createId();
      if (
        isValidEntryId(id) &&
        !this.#snapshot.entries.some((entry) => entry.id === id)
      ) {
        return id;
      }
    }
    throw new WorkflowRecipeLibraryError("id-unavailable");
  }

  #commit(
    entries: readonly WorkflowRecipeLibraryEntry[],
    removeStorage: boolean,
    forceStorage = false,
  ): WorkflowRecipeLibraryCommitResult {
    const memorySnapshot = createSnapshot(
      entries,
      false,
      this.#snapshot.reason ?? "storage-unavailable",
    );
    if (
      this.#storage === null ||
      (this.#memoryOnlyLocked && !forceStorage) ||
      (this.#storageInvalid && !removeStorage)
    ) {
      this.#setSnapshot(memorySnapshot);
      return Object.freeze({ snapshot: this.#snapshot, conflicted: false });
    }

    const storage = this.#storage;
    const expectedSerialized = removeStorage
      ? null
      : serializeStoredEntries(entries);
    try {
      if (expectedSerialized === null) {
        storage.removeItem(WORKFLOW_RECIPE_LIBRARY_STORAGE_KEY);
      } else {
        storage.setItem(
          WORKFLOW_RECIPE_LIBRARY_STORAGE_KEY,
          expectedSerialized,
        );
      }
    } catch {
      this.#memoryOnlyLocked = true;
      this.#setSnapshot(createSnapshot(entries, false, "storage-write-failed"));
      return Object.freeze({ snapshot: this.#snapshot, conflicted: false });
    }

    // localStorage has atomic single operations but no compare-and-swap for a
    // read/modify/write sequence across tabs. Re-read immediately so this
    // synchronous API never reports an already-overwritten mutation as
    // persisted. A valid later writer is the authoritative LWW state.
    let verifiedSerialized: string | null;
    try {
      verifiedSerialized = storage.getItem(WORKFLOW_RECIPE_LIBRARY_STORAGE_KEY);
    } catch {
      this.#memoryOnlyLocked = true;
      this.#setSnapshot(createSnapshot(entries, false, "storage-read-failed"));
      return Object.freeze({ snapshot: this.#snapshot, conflicted: false });
    }

    if (verifiedSerialized !== expectedSerialized) {
      this.#acceptSerializedStorage(verifiedSerialized);
      return Object.freeze({
        snapshot: this.#snapshot,
        conflicted: this.#snapshot.persisted,
      });
    }

    this.#memoryOnlyLocked = false;
    this.#storageInvalid = false;
    this.#setSnapshot(createSnapshot(entries, true));
    return Object.freeze({ snapshot: this.#snapshot, conflicted: false });
  }

  #acceptSerializedStorage(serialized: string | null): void {
    try {
      this.#storageInvalid = false;
      this.#setSnapshot(createSnapshot(parseStoredEntries(serialized), true));
    } catch {
      this.#markReadFailure("invalid-storage");
    }
  }

  #markReadFailure(reason: WorkflowRecipeLibraryPersistenceReason): void {
    if (reason === "storage-read-failed") this.#memoryOnlyLocked = true;
    if (reason === "invalid-storage") this.#storageInvalid = true;
    this.#setSnapshot(createSnapshot(this.#snapshot.entries, false, reason));
  }

  #setSnapshot(snapshot: WorkflowRecipeLibrarySnapshot): void {
    if (this.#destroyed || sameSnapshot(this.#snapshot, snapshot)) return;
    this.#snapshot = snapshot;
    for (const listener of this.#listeners) listener();
  }
}

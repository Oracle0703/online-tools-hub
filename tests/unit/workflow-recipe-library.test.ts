import { describe, expect, it, vi } from "vitest";

import {
  MAX_WORKFLOW_RECIPE_LIBRARY_CANONICAL_BYTES,
  MAX_WORKFLOW_RECIPE_LIBRARY_ENTRIES,
  WORKFLOW_RECIPE_LIBRARY_FORMAT,
  WORKFLOW_RECIPE_LIBRARY_STORAGE_KEY,
  WORKFLOW_RECIPE_LIBRARY_VERSION,
  WorkflowRecipeLibraryError,
  WorkflowRecipeLibraryStore,
  type WorkflowRecipeLibraryStorage,
} from "../../src/lib/workflow-recipe-library";
import {
  MAX_WORKFLOW_RECIPE_BYTES,
  MAX_WORKFLOW_RECIPE_STEPS,
  WORKFLOW_RECIPE_FORMAT,
  WORKFLOW_RECIPE_VERSION,
} from "../../src/workflows/contract";
import { WorkflowError } from "../../src/workflows/errors";

class MemoryStorage implements WorkflowRecipeLibraryStorage {
  readonly values = new Map<string, string>();
  readError: unknown;
  writeError: unknown;

  getItem(key: string): string | null {
    if (this.readError !== undefined) throw this.readError;
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.writeError !== undefined) throw this.writeError;
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    if (this.writeError !== undefined) throw this.writeError;
    this.values.delete(key);
  }
}

class InterleavingStorage extends MemoryStorage {
  afterSet: ((key: string, value: string) => void) | undefined;

  override setItem(key: string, value: string): void {
    super.setItem(key, value);
    const afterSet = this.afterSet;
    this.afterSet = undefined;
    afterSet?.(key, value);
  }
}

function recipe(
  operationId = "json.transform",
  options: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    format: WORKFLOW_RECIPE_FORMAT,
    version: WORKFLOW_RECIPE_VERSION,
    steps: [{ operationId, options }],
  };
}

function createIdSequence(): () => string {
  let value = 0;
  return () => `recipe-${++value}`;
}

function dispatchStorage(
  target: EventTarget,
  newValue: string | null,
  storageArea?: WorkflowRecipeLibraryStorage,
  updateBackingStorage = true,
): void {
  if (updateBackingStorage && storageArea instanceof MemoryStorage) {
    if (newValue === null) {
      storageArea.values.delete(WORKFLOW_RECIPE_LIBRARY_STORAGE_KEY);
    } else {
      storageArea.values.set(WORKFLOW_RECIPE_LIBRARY_STORAGE_KEY, newValue);
    }
  }
  const event = new Event("storage");
  Object.defineProperties(event, {
    key: { value: WORKFLOW_RECIPE_LIBRARY_STORAGE_KEY },
    newValue: { value: newValue },
    storageArea: { value: storageArea ?? null },
  });
  target.dispatchEvent(event);
}

function storedValue(storage: MemoryStorage): string {
  return storage.values.get(WORKFLOW_RECIPE_LIBRARY_STORAGE_KEY)!;
}

describe("workflow recipe library", () => {
  it("is SSR-safe and exposes an explicit memory-only state without window", () => {
    const store = new WorkflowRecipeLibraryStore({ eventTarget: null });

    expect(store.getSnapshot()).toEqual({
      entries: [],
      canonicalBytes: 0,
      persisted: false,
      reason: "storage-unavailable",
    });
    expect(() => store.destroy()).not.toThrow();
  });

  it("compiles before saving and keeps the local envelope separate from recipe v1", () => {
    const storage = new MemoryStorage();
    const listener = vi.fn();
    const store = new WorkflowRecipeLibraryStore({
      storage,
      eventTarget: null,
      now: () => 100,
      createId: () => "recipe-one",
    });
    store.subscribe(listener);

    const result = store.save(recipe("json.transform", { mode: "format" }));
    const entry = result.entry!;
    const persisted = JSON.parse(storedValue(storage)) as Record<
      string,
      unknown
    >;
    const item = (persisted.items as Array<Record<string, unknown>>)[0]!;

    expect(result.persisted).toBe(true);
    expect(listener).toHaveBeenCalledOnce();
    expect(entry).toMatchObject({
      id: "recipe-one",
      updatedAt: 100,
      name: "json.transform",
    });
    expect(entry.recipe.steps[0]?.options).toEqual({
      mode: "format",
      indent: 2,
    });
    expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.isFrozen(entry.recipe)).toBe(true);
    expect(Object.isFrozen(entry.recipe.steps[0]?.options)).toBe(true);
    expect(store.load(entry.id)).toBe(entry.recipe);
    expect(store.copyCanonical(entry.id)).toBe(entry.canonical);

    expect(Object.keys(persisted)).toEqual(["format", "version", "items"]);
    expect(persisted).toMatchObject({
      format: WORKFLOW_RECIPE_LIBRARY_FORMAT,
      version: WORKFLOW_RECIPE_LIBRARY_VERSION,
    });
    expect(Object.keys(item)).toEqual(["id", "updatedAt", "recipe"]);
    expect(item).not.toHaveProperty("name");
    expect(item).not.toHaveProperty("canonical");
    expect(item).not.toHaveProperty("canonicalBytes");
    expect(Object.keys(item.recipe as Record<string, unknown>)).toEqual([
      "format",
      "version",
      "steps",
    ]);
  });

  it("deduplicates canonical recipes, preserves ids and sorts by updatedAt", () => {
    const storage = new MemoryStorage();
    let now = 10;
    const store = new WorkflowRecipeLibraryStore({
      storage,
      eventTarget: null,
      now: () => now,
      createId: createIdSequence(),
    });

    const first = store.save(recipe("json.transform", { mode: "format" }));
    now = 20;
    const second = store.save(recipe("uuid.generate", { count: 2 }));
    now = 30;
    const duplicate = store.save(
      recipe("json.transform", { indent: 2, mode: "format" }),
    );

    expect(first.entry?.id).toBe("recipe-1");
    expect(second.entry?.id).toBe("recipe-2");
    expect(duplicate.entry?.id).toBe("recipe-1");
    expect(store.getSnapshot().entries).toHaveLength(2);
    expect(store.getSnapshot().entries.map((entry) => entry.id)).toEqual([
      "recipe-1",
      "recipe-2",
    ]);
    expect(store.getSnapshot().entries.map((entry) => entry.updatedAt)).toEqual(
      [30, 20],
    );
  });

  it("rejects unknown operations, invalid options and payload-shaped fields before writing", () => {
    const storage = new MemoryStorage();
    const store = new WorkflowRecipeLibraryStore({
      storage,
      eventTarget: null,
      createId: createIdSequence(),
    });
    store.save(recipe());
    const before = storedValue(storage);

    for (const candidate of [
      recipe("missing.operation"),
      recipe("json.transform", { indent: 3 }),
      { ...recipe(), input: "private-canary" },
      {
        ...recipe(),
        steps: [
          {
            operationId: "json.transform",
            options: {},
            result: "private-canary",
          },
        ],
      },
    ]) {
      expect(() => store.save(candidate)).toThrow(WorkflowError);
      expect(storedValue(storage)).toBe(before);
    }
    expect(storedValue(storage)).not.toContain("private-canary");
  });

  it("persists standardized string configuration but rejects free-text canaries", () => {
    const storage = new MemoryStorage();
    const store = new WorkflowRecipeLibraryStore({
      storage,
      eventTarget: null,
      createId: createIdSequence(),
    });
    const valid = store.save(
      recipe("timestamp.convert", {
        direction: "timestamp-to-date",
        unit: "seconds",
        interpretation: "utc",
        timeZone: "Asia/Shanghai",
        locale: "en-CA",
      }),
    );
    expect(valid.persisted).toBe(true);
    expect(storedValue(storage)).toContain("Asia/Shanghai");
    expect(storedValue(storage)).toContain("en-CA");
    const before = storedValue(storage);

    for (const unsafeOptions of [
      {
        direction: "timestamp-to-date",
        timeZone: "PRIVATE_CANARY/secret-body",
      },
      {
        direction: "timestamp-to-date",
        locale: "en-CA-x-private-canary",
      },
    ]) {
      expect(() =>
        store.save(recipe("timestamp.convert", unsafeOptions)),
      ).toThrow(
        expect.objectContaining<Partial<WorkflowRecipeLibraryError>>({
          code: "unsafe-configuration",
        }),
      );
      expect(storedValue(storage)).toBe(before);
    }
    expect(storedValue(storage)).not.toMatch(/PRIVATE_CANARY|private-canary/u);
  });

  it("keeps the last good fallback when storage is corrupt or hostile", () => {
    const storage = new MemoryStorage();
    const store = new WorkflowRecipeLibraryStore({
      storage,
      eventTarget: null,
      createId: createIdSequence(),
    });
    const saved = store.save(recipe()).entry!;

    storage.values.set(WORKFLOW_RECIPE_LIBRARY_STORAGE_KEY, "{broken");
    const afterBrokenJson = store.refresh();
    expect(afterBrokenJson.entries.map((entry) => entry.id)).toEqual([
      saved.id,
    ]);
    expect(afterBrokenJson).toMatchObject({
      persisted: false,
      reason: "invalid-storage",
    });

    storage.values.set(
      WORKFLOW_RECIPE_LIBRARY_STORAGE_KEY,
      JSON.stringify({
        format: WORKFLOW_RECIPE_LIBRARY_FORMAT,
        version: 2,
        items: [],
      }),
    );
    const afterFutureVersion = store.refresh();
    expect(afterFutureVersion.entries.map((entry) => entry.id)).toEqual([
      saved.id,
    ]);
    expect(afterFutureVersion.reason).toBe("invalid-storage");

    storage.values.set(
      WORKFLOW_RECIPE_LIBRARY_STORAGE_KEY,
      JSON.stringify({
        format: WORKFLOW_RECIPE_LIBRARY_FORMAT,
        version: 1,
        items: [
          {
            id: "recipe-hostile",
            updatedAt: 1,
            recipe: recipe("missing.operation"),
          },
        ],
      }),
    );
    expect(store.refresh().entries.map((entry) => entry.id)).toEqual([
      saved.id,
    ]);
  });

  it("never overwrites invalid storage during ordinary saves and recovers only after explicit clear", () => {
    const storage = new MemoryStorage();
    storage.values.set(WORKFLOW_RECIPE_LIBRARY_STORAGE_KEY, "{broken");
    const store = new WorkflowRecipeLibraryStore({
      storage,
      eventTarget: null,
      createId: createIdSequence(),
    });

    const memoryOnly = store.save(recipe());
    expect(memoryOnly).toMatchObject({
      persisted: false,
      reason: "invalid-storage",
    });
    expect(memoryOnly.snapshot.entries).toHaveLength(1);
    expect(storedValue(storage)).toBe("{broken");

    const cleared = store.clear();
    expect(cleared).toMatchObject({ persisted: true });
    expect(cleared.snapshot.entries).toEqual([]);
    expect(storage.values.has(WORKFLOW_RECIPE_LIBRARY_STORAGE_KEY)).toBe(false);

    const recovered = store.save(recipe("uuid.generate", { count: 2 }));
    expect(recovered.persisted).toBe(true);
    expect(storedValue(storage)).toContain("uuid.generate");
  });

  it("fails closed on duplicate canonicals and malformed stored metadata", () => {
    for (const items of [
      [
        { id: "recipe-a", updatedAt: 1, recipe: recipe() },
        { id: "recipe-b", updatedAt: 2, recipe: recipe() },
      ],
      [{ id: "user-title", updatedAt: 1, recipe: recipe() }],
      [{ id: "recipe-a", updatedAt: -1, recipe: recipe() }],
      [
        {
          id: "recipe-a",
          updatedAt: 1,
          recipe: recipe("json.transform", { unknown: true }),
        },
      ],
    ]) {
      const storage = new MemoryStorage();
      storage.values.set(
        WORKFLOW_RECIPE_LIBRARY_STORAGE_KEY,
        JSON.stringify({
          format: WORKFLOW_RECIPE_LIBRARY_FORMAT,
          version: WORKFLOW_RECIPE_LIBRARY_VERSION,
          items,
        }),
      );
      const store = new WorkflowRecipeLibraryStore({
        storage,
        eventTarget: null,
      });
      expect(store.getSnapshot()).toEqual({
        entries: [],
        canonicalBytes: 0,
        persisted: false,
        reason: "invalid-storage",
      });
    }
  });

  it("enforces the 20-item, 512 KiB, 64 KiB and 16-step limits", () => {
    expect(MAX_WORKFLOW_RECIPE_LIBRARY_ENTRIES).toBe(20);
    expect(MAX_WORKFLOW_RECIPE_LIBRARY_CANONICAL_BYTES).toBe(512 * 1024);
    expect(MAX_WORKFLOW_RECIPE_BYTES).toBe(64 * 1024);
    expect(MAX_WORKFLOW_RECIPE_STEPS).toBe(16);

    const storage = new MemoryStorage();
    const store = new WorkflowRecipeLibraryStore({
      storage,
      eventTarget: null,
      createId: createIdSequence(),
    });
    for (let count = 1; count <= 20; count += 1) {
      store.save(recipe("uuid.generate", { count }));
    }
    const before = storedValue(storage);

    expect(() => store.save(recipe("uuid.generate", { count: 21 }))).toThrow(
      expect.objectContaining<Partial<WorkflowRecipeLibraryError>>({
        code: "library-full",
      }),
    );
    expect(storedValue(storage)).toBe(before);
    expect(() =>
      new WorkflowRecipeLibraryStore({ storage: new MemoryStorage() }).save({
        format: WORKFLOW_RECIPE_FORMAT,
        version: WORKFLOW_RECIPE_VERSION,
        steps: Array.from({ length: 17 }, () => ({
          operationId: "json.transform",
          options: {},
        })),
      }),
    ).toThrow(expect.objectContaining({ code: "too-many-steps" }));
  });

  it("degrades unavailable or quota-limited storage inside the current store", () => {
    const memoryStore = new WorkflowRecipeLibraryStore({
      storage: null,
      eventTarget: null,
      createId: () => "recipe-memory",
    });
    const memoryResult = memoryStore.save(recipe());
    expect(memoryResult).toMatchObject({
      persisted: false,
      reason: "storage-unavailable",
    });
    expect(memoryStore.load("recipe-memory")).toBeDefined();

    const storage = new MemoryStorage();
    const events = new EventTarget();
    const quotaStore = new WorkflowRecipeLibraryStore({
      storage,
      eventTarget: events,
      createId: createIdSequence(),
    });
    storage.writeError = new DOMException("quota", "QuotaExceededError");
    const quotaResult = quotaStore.save(recipe());
    expect(quotaResult).toMatchObject({
      persisted: false,
      reason: "storage-write-failed",
    });
    expect(storage.values.has(WORKFLOW_RECIPE_LIBRARY_STORAGE_KEY)).toBe(false);

    dispatchStorage(events, null, storage);
    expect(quotaStore.getSnapshot().entries).toHaveLength(1);
    expect(quotaStore.getSnapshot().reason).toBe("storage-write-failed");
  });

  it("distinguishes storage read failures from invalid stored values", () => {
    const storage = new MemoryStorage();
    storage.readError = new DOMException("denied", "SecurityError");
    const store = new WorkflowRecipeLibraryStore({
      storage,
      eventTarget: null,
    });

    expect(store.getSnapshot()).toMatchObject({
      persisted: false,
      reason: "storage-read-failed",
    });
  });

  it("synchronizes valid storage events and ignores invalid or foreign events", () => {
    const storage = new MemoryStorage();
    const source = new WorkflowRecipeLibraryStore({
      storage,
      eventTarget: null,
      createId: () => "recipe-shared",
    });
    const receiverEvents = new EventTarget();
    const receiver = new WorkflowRecipeLibraryStore({
      storage,
      eventTarget: receiverEvents,
    });
    const listener = vi.fn();
    receiver.subscribe(listener);

    source.save(recipe());
    dispatchStorage(receiverEvents, storedValue(storage), storage);
    expect(receiver.getSnapshot().entries.map((entry) => entry.id)).toEqual([
      "recipe-shared",
    ]);
    expect(receiver.getSnapshot().persisted).toBe(true);

    const lastValid = storedValue(storage);
    dispatchStorage(receiverEvents, "{broken", storage);
    expect(receiver.getSnapshot().entries.map((entry) => entry.id)).toEqual([
      "recipe-shared",
    ]);
    expect(receiver.getSnapshot().reason).toBe("invalid-storage");

    const foreignStorage = new MemoryStorage();
    dispatchStorage(receiverEvents, null, foreignStorage);
    expect(receiver.getSnapshot().entries).toHaveLength(1);

    storage.values.set(WORKFLOW_RECIPE_LIBRARY_STORAGE_KEY, lastValid);
    source.delete("recipe-shared");
    dispatchStorage(receiverEvents, storedValue(storage), storage);
    expect(receiver.getSnapshot()).toMatchObject({
      entries: [],
      persisted: true,
    });
    expect(listener).toHaveBeenCalledTimes(3);

    receiver.destroy();
    source.save(recipe());
    dispatchStorage(receiverEvents, storedValue(storage), storage);
    expect(receiver.getSnapshot().entries).toHaveLength(0);
  });

  it("ignores stale StorageEvent payloads and refreshes the authoritative latest envelope", () => {
    const storage = new MemoryStorage();
    const source = new WorkflowRecipeLibraryStore({
      storage,
      eventTarget: null,
      createId: createIdSequence(),
    });
    source.save(recipe());
    const olderEnvelope = storedValue(storage);

    const events = new EventTarget();
    const receiver = new WorkflowRecipeLibraryStore({
      storage,
      eventTarget: events,
    });
    source.save(recipe("uuid.generate", { count: 2 }));
    const newestEnvelope = storedValue(storage);
    dispatchStorage(events, newestEnvelope, storage);
    expect(receiver.getSnapshot().entries).toHaveLength(2);

    dispatchStorage(events, olderEnvelope, storage, false);
    expect(storedValue(storage)).toBe(newestEnvelope);
    expect(receiver.getSnapshot()).toMatchObject({
      persisted: true,
      entries: expect.arrayContaining([
        expect.objectContaining({ id: "recipe-1" }),
        expect.objectContaining({ id: "recipe-2" }),
      ]),
    });
  });

  it("re-reads the latest envelope before every save, delete and clear mutation", () => {
    const storage = new MemoryStorage();
    const firstStore = new WorkflowRecipeLibraryStore({
      storage,
      eventTarget: null,
      now: () => 10,
      createId: () => "recipe-first",
    });
    const staleStore = new WorkflowRecipeLibraryStore({
      storage,
      eventTarget: null,
      now: () => 20,
      createId: () => "recipe-second",
    });
    const staleClearStore = new WorkflowRecipeLibraryStore({
      storage,
      eventTarget: null,
    });

    firstStore.save(recipe());
    staleStore.save(recipe("uuid.generate", { count: 2 }));

    expect(staleStore.getSnapshot().entries.map((entry) => entry.id)).toEqual([
      "recipe-second",
      "recipe-first",
    ]);
    expect(
      new WorkflowRecipeLibraryStore({ storage, eventTarget: null })
        .getSnapshot()
        .entries.map((entry) => entry.id),
    ).toEqual(["recipe-second", "recipe-first"]);

    firstStore.delete("recipe-first");
    expect(firstStore.getSnapshot().entries.map((entry) => entry.id)).toEqual([
      "recipe-second",
    ]);

    staleClearStore.clear();
    expect(storage.values.has(WORKFLOW_RECIPE_LIBRARY_STORAGE_KEY)).toBe(false);
  });

  it("refreshes stale state before load and canonical-copy lookups", () => {
    const storage = new MemoryStorage();
    const source = new WorkflowRecipeLibraryStore({
      storage,
      eventTarget: null,
      createId: createIdSequence(),
    });
    const staleReader = new WorkflowRecipeLibraryStore({
      storage,
      eventTarget: null,
    });

    const saved = source.save(recipe("uuid.generate", { count: 2 })).entry!;
    expect(staleReader.load(saved.id)).toEqual(saved.recipe);
    expect(staleReader.copyCanonical(saved.id)).toBe(saved.canonical);

    source.delete(saved.id);
    expect(staleReader.load(saved.id)).toBeUndefined();
    expect(staleReader.copyCanonical(saved.id)).toBeUndefined();
  });

  it("uses verified last-writer-wins and never reports an overwritten save as persisted", () => {
    const winningStorage = new MemoryStorage();
    const winningStore = new WorkflowRecipeLibraryStore({
      storage: winningStorage,
      eventTarget: null,
      now: () => 20,
      createId: () => "recipe-winner",
    });
    winningStore.save(recipe("uuid.generate", { count: 2 }));
    const winningEnvelope = storedValue(winningStorage);

    const storage = new InterleavingStorage();
    const losingStore = new WorkflowRecipeLibraryStore({
      storage,
      eventTarget: null,
      now: () => 10,
      createId: () => "recipe-loser",
    });
    storage.afterSet = (key) => storage.values.set(key, winningEnvelope);

    const result = losingStore.save(recipe());

    expect(result).toMatchObject({
      persisted: false,
      reason: "storage-write-conflict",
      snapshot: {
        persisted: true,
        entries: [expect.objectContaining({ id: "recipe-winner" })],
      },
    });
    expect(result).not.toHaveProperty("entry");
    expect(storedValue(storage)).toBe(winningEnvelope);
    expect(losingStore.getSnapshot().entries.map((entry) => entry.id)).toEqual([
      "recipe-winner",
    ]);
  });

  it("treats a cross-tab localStorage clear event as an empty valid library", () => {
    const storage = new MemoryStorage();
    const events = new EventTarget();
    const store = new WorkflowRecipeLibraryStore({
      storage,
      eventTarget: events,
      createId: createIdSequence(),
    });
    store.save(recipe());
    storage.values.delete(WORKFLOW_RECIPE_LIBRARY_STORAGE_KEY);

    const event = new Event("storage");
    Object.defineProperties(event, {
      key: { value: null },
      newValue: { value: null },
      storageArea: { value: storage },
    });
    events.dispatchEvent(event);

    expect(store.getSnapshot()).toMatchObject({
      entries: [],
      persisted: true,
    });
  });

  it("deletes individual entries and removes storage on explicit clear", () => {
    const storage = new MemoryStorage();
    const store = new WorkflowRecipeLibraryStore({
      storage,
      eventTarget: null,
      createId: createIdSequence(),
    });
    const first = store.save(recipe()).entry!;
    store.save(recipe("uuid.generate", { count: 2 }));

    expect(store.delete(first.id).snapshot.entries).toHaveLength(1);
    expect(store.delete("recipe-missing").snapshot.entries).toHaveLength(1);
    const cleared = store.clear();
    expect(cleared).toMatchObject({ persisted: true });
    expect(cleared.snapshot.entries).toEqual([]);
    expect(storage.values.has(WORKFLOW_RECIPE_LIBRARY_STORAGE_KEY)).toBe(false);
  });

  it("lets explicit clear retry a transient failed delete without reviving old state", () => {
    const storage = new MemoryStorage();
    const store = new WorkflowRecipeLibraryStore({
      storage,
      eventTarget: null,
      createId: createIdSequence(),
    });
    const saved = store.save(recipe()).entry!;
    const oldEnvelope = storedValue(storage);

    storage.writeError = new DOMException("quota", "QuotaExceededError");
    const failedDelete = store.delete(saved.id);
    expect(failedDelete).toMatchObject({
      persisted: false,
      reason: "storage-write-failed",
    });
    expect(failedDelete.snapshot.entries).toEqual([]);
    expect(storedValue(storage)).toBe(oldEnvelope);

    storage.writeError = undefined;
    const retried = store.clear();
    expect(retried).toMatchObject({ persisted: true });
    expect(storage.values.has(WORKFLOW_RECIPE_LIBRARY_STORAGE_KEY)).toBe(false);
    expect(
      new WorkflowRecipeLibraryStore({
        storage,
        eventTarget: null,
      }).getSnapshot().entries,
    ).toEqual([]);
  });
});

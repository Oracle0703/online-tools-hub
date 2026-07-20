import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MAX_FAVORITE_TOOLS,
  MAX_RECENT_TOOLS,
  TOOL_MEMORY_EVENT,
  TOOL_MEMORY_STORAGE_KEY,
  clearRecentInMemory,
  clearRecentTools,
  createEmptyToolMemory,
  isToolFavorite,
  isValidToolSlug,
  parseToolMemory,
  readToolMemory,
  recordToolVisit,
  recordVisitInMemory,
  sanitizeToolMemory,
  serializeToolMemory,
  setFavoriteInMemory,
  setToolFavorite,
  subscribeToolMemory,
  toggleToolFavorite,
  type ToolMemoryStorage,
} from "../../src/lib/tool-memory";

function memoryStorage(initial?: string): ToolMemoryStorage & {
  value: string | null;
} {
  return {
    value: initial ?? null,
    getItem() {
      return this.value;
    },
    setItem(_key, value) {
      this.value = value;
    },
  };
}

describe("tool memory", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses a versioned key and accepts only route-safe slugs", () => {
    expect(TOOL_MEMORY_STORAGE_KEY).toContain(":v1");
    expect(isValidToolSlug("json-formatter")).toBe(true);
    expect(isValidToolSlug("../private")).toBe(false);
    expect(isValidToolSlug("JSON Formatter")).toBe(false);
  });

  it("returns an empty state for missing, malformed or unknown versions", () => {
    expect(parseToolMemory(null)).toEqual(createEmptyToolMemory());
    expect(parseToolMemory(undefined)).toEqual(createEmptyToolMemory());
    expect(parseToolMemory("")).toEqual(createEmptyToolMemory());
    expect(parseToolMemory("not-json")).toEqual(createEmptyToolMemory());
    expect(parseToolMemory('{"version":2}')).toEqual(createEmptyToolMemory());
    expect(sanitizeToolMemory(null)).toEqual(createEmptyToolMemory());

    expect(
      sanitizeToolMemory({
        version: 1,
        favorites: "not-an-array",
        recent: [
          null,
          "not-an-entry",
          {},
          { slug: "bad-time", at: -1 },
          { slug: "same", at: 5.9 },
          { slug: "same", at: 5 },
          { slug: "alpha", at: 5 },
        ],
      }),
    ).toEqual({
      version: 1,
      favorites: [],
      recent: [
        { slug: "alpha", at: 5 },
        { slug: "same", at: 5 },
      ],
    });
  });

  it("sanitizes, deduplicates, sorts and caps persisted entries", () => {
    const recent = Array.from({ length: MAX_RECENT_TOOLS + 4 }, (_, index) => ({
      slug: `tool-${index}`,
      at: index,
      ignoredInput: "must not survive",
    }));
    recent.push(
      { slug: "tool-1", at: 999, ignoredInput: "duplicate" },
      { slug: "../unsafe", at: 1000, ignoredInput: "unsafe" },
      { slug: "tool-bad-time", at: Number.NaN, ignoredInput: "invalid" },
    );

    const memory = sanitizeToolMemory({
      version: 1,
      favorites: Array.from({ length: MAX_FAVORITE_TOOLS + 2 }, (_, index) => ({
        slug: `favorite-${index}`,
        at: index,
      })),
      recent,
      rawInput: "secret",
      result: "secret",
    });

    expect(memory.favorites).toHaveLength(MAX_FAVORITE_TOOLS);
    expect(memory.recent).toHaveLength(MAX_RECENT_TOOLS);
    expect(memory.recent[0]).toEqual({ slug: "tool-1", at: 999 });
    expect(serializeToolMemory(memory)).not.toContain("secret");
    expect(serializeToolMemory(memory)).not.toContain("ignoredInput");
  });

  it("adds, updates and removes favorites without changing recent tools", () => {
    const visited = recordVisitInMemory(
      createEmptyToolMemory(),
      "url-codec",
      10,
    );
    const favorite = setFavoriteInMemory(visited, "json-formatter", true, 20);
    const updated = setFavoriteInMemory(favorite, "json-formatter", true, 30);
    const removed = setFavoriteInMemory(updated, "json-formatter", false, 40);

    expect(isToolFavorite("json-formatter", favorite)).toBe(true);
    expect(updated.favorites).toEqual([{ slug: "json-formatter", at: 30 }]);
    expect(removed.favorites).toEqual([]);
    expect(removed.recent).toEqual([{ slug: "url-codec", at: 10 }]);
    expect(setFavoriteInMemory(favorite, "bad/slug", true, 50)).toEqual(
      favorite,
    );
    expect(
      setFavoriteInMemory(favorite, "json-formatter", true, Number.NaN),
    ).toEqual(favorite);
  });

  it("moves repeat visits to the front and clears only recent tools", () => {
    let memory = createEmptyToolMemory();
    memory = setFavoriteInMemory(memory, "json-formatter", true, 1);

    for (let index = 0; index < MAX_RECENT_TOOLS + 3; index += 1) {
      memory = recordVisitInMemory(memory, `tool-${index}`, index + 2);
    }
    memory = recordVisitInMemory(memory, "tool-5", 100);

    expect(memory.recent).toHaveLength(MAX_RECENT_TOOLS);
    expect(memory.recent[0]).toEqual({ slug: "tool-5", at: 100 });
    expect(clearRecentInMemory(memory)).toEqual({
      version: 1,
      favorites: [{ slug: "json-formatter", at: 1 }],
      recent: [],
    });
    expect(recordVisitInMemory(memory, "bad/slug", 101)).toEqual(memory);
    expect(recordVisitInMemory(memory, "valid-slug", -1)).toEqual(memory);
  });

  it("persists public mutations and emits the stable change event", () => {
    const storage = memoryStorage();
    const eventTarget = new EventTarget();
    const listener = vi.fn();
    eventTarget.addEventListener(TOOL_MEMORY_EVENT, listener);
    const environment = { storage, eventTarget, now: () => 42 };

    let memory = setToolFavorite("json-formatter", true, environment);
    expect(isToolFavorite("json-formatter", memory)).toBe(true);

    memory = toggleToolFavorite("json-formatter", environment);
    expect(isToolFavorite("json-formatter", memory)).toBe(false);

    memory = recordToolVisit("url-codec", environment);
    expect(memory.recent).toEqual([{ slug: "url-codec", at: 42 }]);

    memory = clearRecentTools(environment);
    expect(memory.recent).toEqual([]);
    expect(listener).toHaveBeenCalledTimes(4);
    expect(storage.value).toBe(serializeToolMemory(memory));
    expect(readToolMemory({ storage })).toEqual(memory);
  });

  it("falls back safely when storage access throws", () => {
    const throwingStorage: ToolMemoryStorage = {
      getItem() {
        throw new DOMException("blocked", "SecurityError");
      },
      setItem() {
        throw new DOMException("blocked", "SecurityError");
      },
    };

    const memory = recordToolVisit("uuid-generator", {
      storage: throwingStorage,
      eventTarget: null,
      now: () => 84,
    });

    expect(memory.recent[0]).toEqual({ slug: "uuid-generator", at: 84 });
    expect(readToolMemory({ storage: throwingStorage })).toEqual(memory);
    expect(readToolMemory()).toEqual(createEmptyToolMemory());
  });

  it("subscribes to same-page and cross-tab browser changes", () => {
    const storage = memoryStorage(serializeToolMemory(createEmptyToolMemory()));
    const browserWindow = new EventTarget();
    Object.defineProperty(browserWindow, "localStorage", { value: storage });
    vi.stubGlobal("window", browserWindow);

    const listener = vi.fn();
    const unsubscribe = subscribeToolMemory(listener);

    setToolFavorite("base64-codec", true, { now: () => 123 });
    expect(listener).toHaveBeenLastCalledWith({
      version: 1,
      favorites: [{ slug: "base64-codec", at: 123 }],
      recent: [],
    });

    browserWindow.dispatchEvent(new Event(TOOL_MEMORY_EVENT));
    expect(listener).toHaveBeenCalledTimes(2);

    const crossTabMemory = recordVisitInMemory(
      createEmptyToolMemory(),
      "unix-timestamp",
      456,
    );
    const storageEvent = new Event("storage");
    Object.defineProperties(storageEvent, {
      key: { value: TOOL_MEMORY_STORAGE_KEY },
      newValue: { value: serializeToolMemory(crossTabMemory) },
      storageArea: { value: storage },
    });
    browserWindow.dispatchEvent(storageEvent);
    expect(listener).toHaveBeenLastCalledWith(crossTabMemory);

    const unrelatedEvent = new Event("storage");
    Object.defineProperty(unrelatedEvent, "key", { value: "unrelated" });
    browserWindow.dispatchEvent(unrelatedEvent);
    expect(listener).toHaveBeenCalledTimes(3);

    unsubscribe();
    browserWindow.dispatchEvent(new Event(TOOL_MEMORY_EVENT));
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("returns a no-op subscription during SSR", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToolMemory(listener);

    expect(unsubscribe()).toBeUndefined();
    expect(listener).not.toHaveBeenCalled();
  });
});

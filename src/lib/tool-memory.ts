export const TOOL_MEMORY_VERSION = 1 as const;
export const TOOL_MEMORY_STORAGE_KEY =
  "online-tools-hub:tool-memory:v1" as const;
export const TOOL_MEMORY_EVENT = "online-tools-hub:tool-memory-change" as const;
export const MAX_FAVORITE_TOOLS = 64;
export const MAX_RECENT_TOOLS = 12;

export type ToolMemoryEntry = {
  slug: string;
  at: number;
};

export type ToolMemoryState = {
  version: typeof TOOL_MEMORY_VERSION;
  favorites: ToolMemoryEntry[];
  recent: ToolMemoryEntry[];
};

export type ToolMemoryStorage = Pick<Storage, "getItem" | "setItem">;

export type ToolMemoryEnvironment = {
  storage?: ToolMemoryStorage | null;
  eventTarget?: Pick<EventTarget, "dispatchEvent"> | null;
  now?: () => number;
};

export type ToolMemoryListener = (memory: ToolMemoryState) => void;

const TOOL_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

let fallbackMemory: ToolMemoryState = createEmptyToolMemory();

export function createEmptyToolMemory(): ToolMemoryState {
  return {
    version: TOOL_MEMORY_VERSION,
    favorites: [],
    recent: [],
  };
}

export function isValidToolSlug(slug: string): boolean {
  return TOOL_SLUG_PATTERN.test(slug);
}

function normalizeTimestamp(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }

  return Math.trunc(value);
}

function normalizeEntries(value: unknown, limit: number): ToolMemoryEntry[] {
  if (!Array.isArray(value)) return [];

  const newestBySlug = new Map<string, number>();

  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object") continue;

    const { slug, at } = candidate as Partial<ToolMemoryEntry>;
    const normalizedAt = normalizeTimestamp(at);

    if (
      typeof slug !== "string" ||
      !isValidToolSlug(slug) ||
      normalizedAt === undefined
    ) {
      continue;
    }

    const previousAt = newestBySlug.get(slug);
    if (previousAt === undefined || normalizedAt > previousAt) {
      newestBySlug.set(slug, normalizedAt);
    }
  }

  return [...newestBySlug]
    .map(([slug, at]) => ({ slug, at }))
    .sort(
      (left, right) =>
        right.at - left.at || left.slug.localeCompare(right.slug),
    )
    .slice(0, limit);
}

export function sanitizeToolMemory(value: unknown): ToolMemoryState {
  if (!value || typeof value !== "object") return createEmptyToolMemory();

  const candidate = value as Partial<ToolMemoryState>;
  if (candidate.version !== TOOL_MEMORY_VERSION) {
    return createEmptyToolMemory();
  }

  return {
    version: TOOL_MEMORY_VERSION,
    favorites: normalizeEntries(candidate.favorites, MAX_FAVORITE_TOOLS),
    recent: normalizeEntries(candidate.recent, MAX_RECENT_TOOLS),
  };
}

export function parseToolMemory(
  serialized: string | null | undefined,
): ToolMemoryState {
  if (!serialized) return createEmptyToolMemory();

  try {
    return sanitizeToolMemory(JSON.parse(serialized) as unknown);
  } catch {
    return createEmptyToolMemory();
  }
}

export function serializeToolMemory(memory: ToolMemoryState): string {
  return JSON.stringify(sanitizeToolMemory(memory));
}

export function setFavoriteInMemory(
  memory: ToolMemoryState,
  slug: string,
  favorite: boolean,
  at: number,
): ToolMemoryState {
  const current = sanitizeToolMemory(memory);
  const normalizedAt = normalizeTimestamp(at);

  if (!isValidToolSlug(slug) || normalizedAt === undefined) return current;

  const favorites = current.favorites.filter((entry) => entry.slug !== slug);

  return sanitizeToolMemory({
    ...current,
    favorites: favorite
      ? [{ slug, at: normalizedAt }, ...favorites]
      : favorites,
  });
}

export function recordVisitInMemory(
  memory: ToolMemoryState,
  slug: string,
  at: number,
): ToolMemoryState {
  const current = sanitizeToolMemory(memory);
  const normalizedAt = normalizeTimestamp(at);

  if (!isValidToolSlug(slug) || normalizedAt === undefined) return current;

  return sanitizeToolMemory({
    ...current,
    recent: [
      { slug, at: normalizedAt },
      ...current.recent.filter((entry) => entry.slug !== slug),
    ],
  });
}

export function clearRecentInMemory(memory: ToolMemoryState): ToolMemoryState {
  return {
    ...sanitizeToolMemory(memory),
    recent: [],
  };
}

export function isToolFavorite(slug: string, memory: ToolMemoryState): boolean {
  return memory.favorites.some((entry) => entry.slug === slug);
}

function resolveStorage(
  environment: ToolMemoryEnvironment,
): ToolMemoryStorage | null {
  if (environment.storage !== undefined) return environment.storage;
  if (typeof window === "undefined") return null;

  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function canUseFallback(environment: ToolMemoryEnvironment): boolean {
  return typeof window !== "undefined" || environment.storage !== undefined;
}

function copyToolMemory(memory: ToolMemoryState): ToolMemoryState {
  return {
    version: TOOL_MEMORY_VERSION,
    favorites: memory.favorites.map((entry) => ({ ...entry })),
    recent: memory.recent.map((entry) => ({ ...entry })),
  };
}

export function readToolMemory(
  environment: ToolMemoryEnvironment = {},
): ToolMemoryState {
  const storage = resolveStorage(environment);

  if (!storage) {
    return canUseFallback(environment)
      ? copyToolMemory(fallbackMemory)
      : createEmptyToolMemory();
  }

  try {
    const memory = parseToolMemory(storage.getItem(TOOL_MEMORY_STORAGE_KEY));
    fallbackMemory = memory;
    return copyToolMemory(memory);
  } catch {
    return copyToolMemory(fallbackMemory);
  }
}

function dispatchToolMemoryChange(
  memory: ToolMemoryState,
  environment: ToolMemoryEnvironment,
): void {
  const target =
    environment.eventTarget !== undefined
      ? environment.eventTarget
      : typeof window === "undefined"
        ? null
        : window;

  if (!target || typeof CustomEvent === "undefined") return;

  target.dispatchEvent(
    new CustomEvent<ToolMemoryState>(TOOL_MEMORY_EVENT, {
      detail: copyToolMemory(memory),
    }),
  );
}

function mutateToolMemory(
  update: (memory: ToolMemoryState, at: number) => ToolMemoryState,
  environment: ToolMemoryEnvironment,
): ToolMemoryState {
  const current = readToolMemory(environment);
  const now = normalizeTimestamp((environment.now ?? Date.now)()) ?? Date.now();
  const next = sanitizeToolMemory(update(current, now));

  if (canUseFallback(environment)) fallbackMemory = next;

  const storage = resolveStorage(environment);
  try {
    storage?.setItem(TOOL_MEMORY_STORAGE_KEY, serializeToolMemory(next));
  } catch {
    // localStorage may be unavailable (private mode, policy or quota). The
    // in-memory fallback still keeps controls working for this page session.
  }

  dispatchToolMemoryChange(next, environment);
  return copyToolMemory(next);
}

export function setToolFavorite(
  slug: string,
  favorite: boolean,
  environment: ToolMemoryEnvironment = {},
): ToolMemoryState {
  return mutateToolMemory(
    (memory, at) => setFavoriteInMemory(memory, slug, favorite, at),
    environment,
  );
}

export function toggleToolFavorite(
  slug: string,
  environment: ToolMemoryEnvironment = {},
): ToolMemoryState {
  return mutateToolMemory(
    (memory, at) =>
      setFavoriteInMemory(memory, slug, !isToolFavorite(slug, memory), at),
    environment,
  );
}

export function recordToolVisit(
  slug: string,
  environment: ToolMemoryEnvironment = {},
): ToolMemoryState {
  return mutateToolMemory(
    (memory, at) => recordVisitInMemory(memory, slug, at),
    environment,
  );
}

export function clearRecentTools(
  environment: ToolMemoryEnvironment = {},
): ToolMemoryState {
  return mutateToolMemory((memory) => clearRecentInMemory(memory), environment);
}

export function subscribeToolMemory(listener: ToolMemoryListener): () => void {
  if (typeof window === "undefined") return () => undefined;

  const handleChange = (event: Event) => {
    const detail = (event as CustomEvent<unknown>).detail;
    listener(
      detail === undefined ? readToolMemory() : sanitizeToolMemory(detail),
    );
  };

  const handleStorage = (event: StorageEvent) => {
    if (event.key !== null && event.key !== TOOL_MEMORY_STORAGE_KEY) {
      return;
    }

    try {
      if (event.storageArea && event.storageArea !== window.localStorage)
        return;
    } catch {
      return;
    }

    const memory = parseToolMemory(event.newValue);
    fallbackMemory = memory;
    listener(copyToolMemory(memory));
  };

  window.addEventListener(TOOL_MEMORY_EVENT, handleChange);
  window.addEventListener("storage", handleStorage);

  return () => {
    window.removeEventListener(TOOL_MEMORY_EVENT, handleChange);
    window.removeEventListener("storage", handleStorage);
  };
}

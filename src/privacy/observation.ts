export const PRIVACY_OBSERVATION_MAX_CACHE_RESPONSE_BYTES = 4 * 1024 * 1024;
export const PRIVACY_OBSERVATION_MAX_TOTAL_CACHE_BYTES = 32 * 1024 * 1024;
export const PRIVACY_OBSERVATION_MAX_CACHE_NAMES = 256;
export const PRIVACY_OBSERVATION_MAX_CACHE_REQUESTS = 2_048;
export const PRIVACY_OBSERVATION_MAX_DATABASE_NAMES = 256;

const SITE_CACHE_PREFIX = "online-tools-hub-";

export class PrivacyObservationUnavailableError extends Error {
  constructor() {
    super("Privacy observation is unavailable.");
    this.name = "PrivacyObservationUnavailableError";
  }
}

export class PrivacyObservationAbortedError extends Error {
  constructor() {
    super("Privacy observation was aborted.");
    this.name = "PrivacyObservationAbortedError";
  }
}

export interface PrivacyObservableState {
  readonly serialized: string;
  readonly cacheMetadataValid: boolean;
  readonly cacheResponseContainsSensitiveData: boolean;
}

interface DatabaseInfoLike {
  readonly name?: string | null;
}

interface PrivacyCacheLike {
  keys(): PromiseLike<readonly Request[]>;
  match(request: Request): PromiseLike<Response | undefined>;
}

export interface PrivacyObservationEnvironment {
  readonly origin: string;
  readonly href: string;
  readonly historyState: unknown;
  readonly cookie: string;
  readonly localStorage: object;
  readonly sessionStorage: object;
  readonly indexedDB: {
    databases(): PromiseLike<readonly DatabaseInfoLike[]>;
  };
  readonly caches: {
    keys(): PromiseLike<readonly string[]>;
    open(name: string): PromiseLike<PrivacyCacheLike>;
  };
}

export interface CapturePrivacyObservableStateOptions {
  readonly basePath: string;
  readonly signal: AbortSignal;
  readonly representations: readonly string[];
  readonly environment?: PrivacyObservationEnvironment;
}

export function throwIfPrivacyObservationAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new PrivacyObservationAbortedError();
}

/**
 * Starts an observation only while its signal is live, consumes late host
 * rejections after cancellation, and never waits for an uncooperative host
 * promise before reporting the abort.
 */
export function awaitPrivacyObservation<T>(
  signal: AbortSignal,
  start: () => PromiseLike<T>,
  onAbort?: () => void,
): Promise<T> {
  if (signal.aborted)
    return Promise.reject(new PrivacyObservationAbortedError());

  return new Promise<T>((resolve, reject) => {
    let settled = false;

    const detach = () => {
      try {
        signal.removeEventListener("abort", abort);
      } catch {
        // A non-standard signal cannot keep the observation alive.
      }
    };
    const resolveOnce = (value: T) => {
      if (settled) return;
      settled = true;
      detach();
      resolve(value);
    };
    const rejectOnce = (error: unknown) => {
      if (settled) return;
      settled = true;
      detach();
      reject(error);
    };
    const abort = () => {
      if (settled) return;
      settled = true;
      detach();
      try {
        onAbort?.();
      } catch {
        // Cancellation is best effort; the caller still observes the abort.
      }
      reject(new PrivacyObservationAbortedError());
    };

    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
      return;
    }

    let pending: Promise<T>;
    try {
      pending = Promise.resolve(start());
    } catch (error) {
      rejectOnce(error);
      return;
    }
    pending.then(resolveOnce, rejectOnce);
  });
}

function safeSerialize(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    throw new PrivacyObservationUnavailableError();
  }
}

function containsRepresentation(
  values: readonly string[],
  representations: readonly string[],
): boolean {
  return values.some((value) =>
    representations.some(
      (representation) =>
        representation.length > 0 && value.includes(representation),
    ),
  );
}

function createBrowserObservationEnvironment(): PrivacyObservationEnvironment {
  return {
    origin: window.location.origin,
    href: window.location.href,
    historyState: window.history.state,
    cookie: document.cookie,
    localStorage,
    sessionStorage,
    indexedDB,
    caches,
  };
}

export async function readBoundedResponseText(
  response: Response,
  signal: AbortSignal,
  total: { value: number },
): Promise<string> {
  const contentLength = response.headers.get("content-length");
  const declaredLength = contentLength === null ? 0 : Number(contentLength);
  if (
    (contentLength !== null &&
      (!Number.isSafeInteger(declaredLength) || declaredLength < 0)) ||
    declaredLength > PRIVACY_OBSERVATION_MAX_CACHE_RESPONSE_BYTES ||
    declaredLength > PRIVACY_OBSERVATION_MAX_TOTAL_CACHE_BYTES - total.value
  ) {
    throw new PrivacyObservationUnavailableError();
  }

  const reader = response.body?.getReader();
  if (reader === undefined) {
    const text = await awaitPrivacyObservation(signal, () => response.text());
    const bytes = new TextEncoder().encode(text).byteLength;
    if (
      bytes > PRIVACY_OBSERVATION_MAX_CACHE_RESPONSE_BYTES ||
      bytes > PRIVACY_OBSERVATION_MAX_TOTAL_CACHE_BYTES - total.value
    ) {
      throw new PrivacyObservationUnavailableError();
    }
    total.value += bytes;
    return text;
  }

  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let responseBytes = 0;
  let completed = false;
  let cancellationStarted = false;

  const releaseReader = () => {
    try {
      reader.releaseLock();
    } catch {
      // Some implementations keep the read locked until cancel settles.
    }
  };
  const cancelReader = () => {
    if (cancellationStarted) return;
    cancellationStarted = true;
    try {
      Promise.resolve(reader.cancel()).then(releaseReader, releaseReader);
    } catch {
      // A throwing cancellation still reaches the immediate release attempt.
    }
  };

  try {
    while (true) {
      const part = await awaitPrivacyObservation(
        signal,
        () => reader.read(),
        cancelReader,
      );
      if (part.done) {
        completed = true;
        break;
      }
      if (!(part.value instanceof Uint8Array)) {
        throw new PrivacyObservationUnavailableError();
      }
      responseBytes += part.value.byteLength;
      if (
        responseBytes > PRIVACY_OBSERVATION_MAX_CACHE_RESPONSE_BYTES ||
        responseBytes > PRIVACY_OBSERVATION_MAX_TOTAL_CACHE_BYTES - total.value
      ) {
        throw new PrivacyObservationUnavailableError();
      }
      chunks.push(decoder.decode(part.value, { stream: true }));
    }
    chunks.push(decoder.decode());
    total.value += responseBytes;
    return chunks.join("");
  } finally {
    if (!completed) cancelReader();
    releaseReader();
  }
}

export async function capturePrivacyObservableState({
  basePath,
  signal,
  representations,
  environment,
}: CapturePrivacyObservableStateOptions): Promise<PrivacyObservableState> {
  throwIfPrivacyObservationAborted(signal);
  const observationEnvironment =
    environment ?? createBrowserObservationEnvironment();
  const databases = await awaitPrivacyObservation(signal, () =>
    observationEnvironment.indexedDB.databases(),
  );
  if (databases.length > PRIVACY_OBSERVATION_MAX_DATABASE_NAMES) {
    throw new PrivacyObservationUnavailableError();
  }

  const cacheNames = [
    ...(await awaitPrivacyObservation(signal, () =>
      observationEnvironment.caches.keys(),
    )),
  ].sort((left, right) => left.localeCompare(right, "en"));
  if (cacheNames.length > PRIVACY_OBSERVATION_MAX_CACHE_NAMES) {
    throw new PrivacyObservationUnavailableError();
  }

  const cacheRequests: Array<{
    cache: string;
    method: string;
    url: string;
  }> = [];
  const totalBytes = { value: 0 };
  let cacheMetadataValid = true;
  let cacheResponseContainsSensitiveData = false;

  for (const cacheName of cacheNames) {
    const cache = await awaitPrivacyObservation(signal, () =>
      observationEnvironment.caches.open(cacheName),
    );
    const requests = await awaitPrivacyObservation(signal, () => cache.keys());
    if (
      cacheRequests.length + requests.length >
      PRIVACY_OBSERVATION_MAX_CACHE_REQUESTS
    ) {
      throw new PrivacyObservationUnavailableError();
    }

    for (const request of requests) {
      const response = await awaitPrivacyObservation(signal, () =>
        cache.match(request),
      );
      if (response !== undefined) {
        let clone: Response;
        try {
          clone = response.clone();
        } catch {
          throw new PrivacyObservationUnavailableError();
        }
        const body = await readBoundedResponseText(clone, signal, totalBytes);
        if (containsRepresentation([body], representations)) {
          cacheResponseContainsSensitiveData = true;
        }
      }

      let url: URL | null = null;
      try {
        url = new URL(request.url);
      } catch {
        if (cacheName.startsWith(SITE_CACHE_PREFIX)) {
          cacheMetadataValid = false;
        }
      }
      if (url !== null) {
        const withinSite =
          url.origin === observationEnvironment.origin &&
          url.pathname.startsWith(basePath);
        const belongsToSite =
          cacheName.startsWith(SITE_CACHE_PREFIX) || withinSite;
        if (
          belongsToSite &&
          (!withinSite ||
            request.method !== "GET" ||
            url.search !== "" ||
            url.hash !== "")
        ) {
          cacheMetadataValid = false;
        }
      }
      cacheRequests.push({
        cache: cacheName,
        method: request.method,
        url: request.url,
      });
    }
  }

  return {
    serialized: safeSerialize({
      url: observationEnvironment.href,
      historyState: observationEnvironment.historyState,
      cookie: observationEnvironment.cookie,
      localStorage: Object.entries(observationEnvironment.localStorage),
      sessionStorage: Object.entries(observationEnvironment.sessionStorage),
      indexedDatabaseNames: databases
        .map((database) => database.name ?? "")
        .sort((left, right) => left.localeCompare(right, "en")),
      cacheNames,
      cacheRequests,
    }),
    cacheMetadataValid,
    cacheResponseContainsSensitiveData,
  };
}

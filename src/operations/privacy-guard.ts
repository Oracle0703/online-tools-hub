import { OperationError } from "./errors";

/**
 * Capabilities that an isolated Operation must never reach. The guard is
 * installed before any adapter is dynamically imported inside the Worker.
 */
export const forbiddenOperationWorkerGlobals = Object.freeze([
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "EventSource",
  "WebTransport",
  "RTCPeerConnection",
  "importScripts",
  "Worker",
  "SharedWorker",
  "BroadcastChannel",
  "navigator",
  "indexedDB",
  "caches",
  "localStorage",
  "sessionStorage",
  "document",
] as const);

const guardedTargets = new WeakSet<object>();

function forbiddenCapability(): never {
  throw new OperationError(
    "execution-failed",
    "Operation attempted to use a forbidden capability.",
  );
}

/**
 * Replaces network, persistence, cross-context and DOM entry points with
 * throwing accessors. If a capability cannot be shadowed, startup fails
 * closed instead of running an adapter in a weaker isolation boundary.
 */
export function installOperationWorkerPrivacyGuards(
  target: object = globalThis,
): void {
  if (guardedTargets.has(target)) return;

  for (const name of forbiddenOperationWorkerGlobals) {
    const descriptor = Object.getOwnPropertyDescriptor(target, name);
    if (descriptor?.configurable === false) {
      const unavailable =
        "value" in descriptor && descriptor.value === undefined;
      if (unavailable) continue;
      throw new OperationError(
        "unsupported-environment",
        "The Worker privacy boundary could not be installed.",
      );
    }

    Object.defineProperty(target, name, {
      configurable: false,
      enumerable: false,
      get: forbiddenCapability,
      set: forbiddenCapability,
    });
  }

  guardedTargets.add(target);
}

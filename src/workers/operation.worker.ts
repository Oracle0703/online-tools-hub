import { getOperationManifest } from "../operations/catalog";
import { installOperationWorkerPrivacyGuards } from "../operations/privacy-guard";
import {
  installOperationWorkerRuntime,
  type OperationWorkerScope,
} from "../operations/worker-runtime";
import { loadWorkerOperationDefinition } from "../operations/worker-runtime-registry";

const workerScope = globalThis as unknown as OperationWorkerScope;

// GitHub Pages cannot attach a dedicated CSP response header to this module
// Worker. Install a fail-closed runtime boundary before loading any adapter.
installOperationWorkerPrivacyGuards(globalThis);
installOperationWorkerRuntime(workerScope, {
  getManifest: getOperationManifest,
  loadDefinition: loadWorkerOperationDefinition,
});

export {};

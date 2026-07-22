import { QR_OPERATION_MANIFEST } from "../operations/catalog";
import { OperationError } from "../operations/errors";
import { installOperationWorkerPrivacyGuards } from "../operations/privacy-guard";
import {
  installOperationWorkerRuntime,
  type OperationWorkerScope,
} from "../operations/worker-runtime";

const workerScope = globalThis as unknown as OperationWorkerScope;

// Install the fail-closed boundary before the QR adapter can load uqr/jsQR.
installOperationWorkerPrivacyGuards(globalThis);
installOperationWorkerRuntime(workerScope, {
  getManifest: (operationId) =>
    operationId === QR_OPERATION_MANIFEST.id
      ? QR_OPERATION_MANIFEST
      : undefined,
  loadDefinition: loadQrOperationDefinition,
});

async function loadQrOperationDefinition(operationId: string) {
  if (operationId !== QR_OPERATION_MANIFEST.id) {
    throw new OperationError(
      "unknown-operation",
      "Operation is not registered in the QR Worker.",
    );
  }
  return (await import("../operations/adapters/qr")).qrOperationDefinition;
}

export {};

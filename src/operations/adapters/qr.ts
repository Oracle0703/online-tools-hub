import {
  QR_DISPLAY_SIZES,
  QR_ERROR_CORRECTION_LEVELS,
  QR_INVERSION_ATTEMPTS,
} from "../../tools/qr-code/contract";
import { transformQrCode } from "../../tools/qr-code/core";
import { QR_OPERATION_MANIFEST } from "../catalog";
import type { OperationDefinition } from "../contract";
import {
  assertAllowedOptions,
  checkpoint,
  expectInputKind,
  failFromCore,
  optionalEnum,
} from "./_shared";

const SCAN_WORKING_BYTES_PER_RGBA_BYTE = 6;

export const qrOperationDefinition: OperationDefinition = {
  manifest: QR_OPERATION_MANIFEST,
  execute(input, options, context) {
    const operationId = QR_OPERATION_MANIFEST.id;
    assertAllowedOptions(operationId, options, [
      "mode",
      "ecc",
      "displaySize",
      "inversionAttempts",
    ]);
    const mode = optionalEnum(
      operationId,
      options,
      "mode",
      ["generate", "scan"] as const,
      "generate",
    );
    const ecc = optionalEnum(
      operationId,
      options,
      "ecc",
      QR_ERROR_CORRECTION_LEVELS,
      "M",
    );
    const displaySize = optionalEnum(
      operationId,
      options,
      "displaySize",
      QR_DISPLAY_SIZES,
      512,
    );
    const inversionAttempts = optionalEnum(
      operationId,
      options,
      "inversionAttempts",
      QR_INVERSION_ATTEMPTS,
      "attemptBoth",
    );

    checkpoint(context);
    if (mode === "generate") {
      const source = expectInputKind(operationId, input, "text");
      const result = transformQrCode({
        mode,
        text: source.text,
        ecc,
        displaySize,
      });
      if (!result.ok) failFromCore(operationId, result.error);
      if (result.mode !== "generate") {
        failFromCore(operationId, { code: "unexpected-result-mode" });
      }
      checkpoint(context);
      return { kind: "text", text: result.svg };
    }

    const image = expectInputKind(operationId, input, "rgba-image");
    context.assertWorkingMemory(
      image.data.byteLength * SCAN_WORKING_BYTES_PER_RGBA_BYTE,
    );
    const rgba = new Uint8ClampedArray(image.data).buffer;
    const result = transformQrCode({
      mode,
      rgba,
      width: image.width,
      height: image.height,
      inversionAttempts,
    });
    if (!result.ok) failFromCore(operationId, result.error);
    if (result.mode !== "scan") {
      failFromCore(operationId, { code: "unexpected-result-mode" });
    }
    checkpoint(context);
    return { kind: "text", text: result.text };
  },
};

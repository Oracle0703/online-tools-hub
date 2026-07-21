import { decodeBase64, encodeBase64 } from "../../tools/base64-codec";
import { BASE64_OPERATION_MANIFEST } from "../catalog";
import type { OperationDefinition } from "../contract";
import {
  assertAllowedOptions,
  checkpoint,
  expectInputKind,
  failFromCore,
  mapThrownError,
  optionalEnum,
} from "./_shared";

export const base64OperationDefinition: OperationDefinition = {
  manifest: BASE64_OPERATION_MANIFEST,
  async execute(input, options, context) {
    const operationId = BASE64_OPERATION_MANIFEST.id;
    assertAllowedOptions(operationId, options, [
      "mode",
      "variant",
      "decodedContentType",
    ]);
    const mode = optionalEnum(
      operationId,
      options,
      "mode",
      ["encode", "decode"] as const,
      "encode",
    );
    const variant = optionalEnum(
      operationId,
      options,
      "variant",
      ["standard", "url"] as const,
      "standard",
    );
    // This semantic hint is consumed by the workflow planner. Validating it
    // here keeps direct adapter calls in parity with manifest validation.
    optionalEnum(
      operationId,
      options,
      "decodedContentType",
      [
        "text/plain",
        "application/json",
        "application/yaml",
        "text/csv",
        "application/jwt",
        "application/x-www-form-urlencoded",
      ] as const,
      "text/plain",
    );
    const source = expectInputKind(operationId, input, "text").text;
    checkpoint(context);

    if (mode === "decode") {
      const result = decodeBase64(source, variant);
      if (!result.ok) failFromCore(operationId, result.error);
      checkpoint(context);
      return { kind: "text", text: result.value };
    }

    const text = await mapThrownError(operationId, () =>
      encodeBase64(source, variant),
    );
    checkpoint(context);
    return { kind: "text", text };
  },
};

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
    assertAllowedOptions(operationId, options, ["mode", "variant"]);
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

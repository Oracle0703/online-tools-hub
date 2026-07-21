import { transformUrl } from "../../tools/url-codec";
import { URL_OPERATION_MANIFEST } from "../catalog";
import type { OperationDefinition } from "../contract";
import {
  assertAllowedOptions,
  checkpoint,
  expectInputKind,
  failFromCore,
  optionalBoolean,
  optionalEnum,
} from "./_shared";

export const urlOperationDefinition: OperationDefinition = {
  manifest: URL_OPERATION_MANIFEST,
  execute(input, options, context) {
    const operationId = URL_OPERATION_MANIFEST.id;
    assertAllowedOptions(operationId, options, [
      "mode",
      "scope",
      "formEncoding",
    ]);
    const mode = optionalEnum(
      operationId,
      options,
      "mode",
      ["encode", "decode"] as const,
      "encode",
    );
    const scope = optionalEnum(
      operationId,
      options,
      "scope",
      ["component", "url"] as const,
      "component",
    );
    const formEncoding = optionalBoolean(
      operationId,
      options,
      "formEncoding",
      false,
    );
    const source = expectInputKind(operationId, input, "text").text;
    checkpoint(context);
    const result = transformUrl(source, mode, scope, { formEncoding });
    if (!result.ok) failFromCore(operationId, result.error);
    checkpoint(context);
    return { kind: "text", text: result.value };
  },
};

import { formatJson, minifyJson } from "../../tools/json-formatter";
import { JSON_OPERATION_MANIFEST } from "../catalog";
import type { OperationDefinition } from "../contract";
import {
  assertAllowedOptions,
  checkpoint,
  expectInputKind,
  failFromCore,
  optionalEnum,
} from "./_shared";

export const jsonOperationDefinition: OperationDefinition = {
  manifest: JSON_OPERATION_MANIFEST,
  execute(input, options, context) {
    const operationId = JSON_OPERATION_MANIFEST.id;
    assertAllowedOptions(operationId, options, ["mode", "indent"]);
    const mode = optionalEnum(
      operationId,
      options,
      "mode",
      ["format", "minify"] as const,
      "format",
    );
    const indent = optionalEnum(
      operationId,
      options,
      "indent",
      [2, 4, "tab"] as const,
      2,
    );
    const source = expectInputKind(operationId, input, "text").text;
    checkpoint(context);
    const result =
      mode === "format" ? formatJson(source, indent) : minifyJson(source);
    if (!result.ok) failFromCore(operationId, result.error);
    checkpoint(context);
    return { kind: "text", text: result.value };
  },
};

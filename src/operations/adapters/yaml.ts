import { transformYamlJson } from "../../tools/yaml-json-converter";
import { YAML_OPERATION_MANIFEST } from "../catalog";
import type { OperationDefinition } from "../contract";
import {
  assertAllowedOptions,
  checkpoint,
  expectInputKind,
  failFromCore,
  optionalEnum,
} from "./_shared";

export const yamlOperationDefinition: OperationDefinition = {
  manifest: YAML_OPERATION_MANIFEST,
  execute(input, options, context) {
    const operationId = YAML_OPERATION_MANIFEST.id;
    assertAllowedOptions(operationId, options, ["direction", "jsonIndent"]);
    const direction = optionalEnum(
      operationId,
      options,
      "direction",
      ["yaml-to-json", "json-to-yaml"] as const,
      "yaml-to-json",
    );
    const jsonIndent = optionalEnum(
      operationId,
      options,
      "jsonIndent",
      [2, 4] as const,
      2,
    );
    const source = expectInputKind(operationId, input, "text").text;
    checkpoint(context);
    const result = transformYamlJson(source, direction, { jsonIndent });
    if (!result.ok) failFromCore(operationId, result.error);
    checkpoint(context);
    return { kind: "text", text: result.value };
  },
};

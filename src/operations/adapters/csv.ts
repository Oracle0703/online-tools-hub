import { transformCsvJson } from "../../tools/csv-json-converter";
import { CSV_OPERATION_MANIFEST } from "../catalog";
import type { OperationDefinition } from "../contract";
import {
  assertAllowedOptions,
  checkpoint,
  expectInputKind,
  failFromCore,
  optionalEnum,
} from "./_shared";

export const csvOperationDefinition: OperationDefinition = {
  manifest: CSV_OPERATION_MANIFEST,
  execute(input, options, context) {
    const operationId = CSV_OPERATION_MANIFEST.id;
    assertAllowedOptions(operationId, options, [
      "direction",
      "delimiter",
      "jsonIndent",
    ]);
    const direction = optionalEnum(
      operationId,
      options,
      "direction",
      ["csv-to-json", "json-to-csv"] as const,
      "csv-to-json",
    );
    const delimiter = optionalEnum(
      operationId,
      options,
      "delimiter",
      ["auto", ",", ";", "\t"] as const,
      "auto",
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
    const result = transformCsvJson(source, direction, {
      delimiter,
      jsonIndent,
    });
    if (!result.ok) failFromCore(operationId, result.error);
    checkpoint(context);
    return { kind: "text", text: result.value };
  },
};

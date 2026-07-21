import {
  convertDateTime,
  convertTimestamp,
} from "../../tools/timestamp-converter";
import { TIMESTAMP_OPERATION_MANIFEST } from "../catalog";
import type { OperationDefinition } from "../contract";
import {
  assertAllowedOptions,
  checkpoint,
  expectInputKind,
  failFromCore,
  optionalEnum,
  optionalString,
} from "./_shared";

export const timestampOperationDefinition: OperationDefinition = {
  manifest: TIMESTAMP_OPERATION_MANIFEST,
  execute(input, options, context) {
    const operationId = TIMESTAMP_OPERATION_MANIFEST.id;
    assertAllowedOptions(operationId, options, [
      "direction",
      "unit",
      "interpretation",
      "timeZone",
      "locale",
    ]);
    const direction = optionalEnum(
      operationId,
      options,
      "direction",
      ["timestamp-to-date", "date-to-timestamp"] as const,
      "timestamp-to-date",
    );
    const unit = optionalEnum(
      operationId,
      options,
      "unit",
      ["auto", "seconds", "milliseconds"] as const,
      "auto",
    );
    const interpretation = optionalEnum(
      operationId,
      options,
      "interpretation",
      ["local", "utc"] as const,
      "local",
    );
    const timeZone = optionalString(
      operationId,
      options,
      "timeZone",
      undefined,
    );
    const locale = optionalString(
      operationId,
      options,
      "locale",
      undefined,
      64,
    );
    const source = expectInputKind(operationId, input, "text").text;
    checkpoint(context);
    const result =
      direction === "timestamp-to-date"
        ? convertTimestamp(source, unit, { timeZone, locale })
        : convertDateTime(source, interpretation, { timeZone, locale });
    if (!result.ok) failFromCore(operationId, result.error);
    checkpoint(context);
    return { kind: "text", text: JSON.stringify(result.value, null, 2) };
  },
};

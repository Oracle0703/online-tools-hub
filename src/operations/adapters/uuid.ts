import {
  MAX_UUID_COUNT,
  MIN_UUID_COUNT,
  generateUuidV4,
} from "../../tools/uuid-generator";
import { UUID_OPERATION_MANIFEST } from "../catalog";
import type { OperationDefinition } from "../contract";
import {
  assertAllowedOptions,
  checkpoint,
  expectInputKind,
  failFromCore,
  optionalInteger,
} from "./_shared";

export const uuidOperationDefinition: OperationDefinition = {
  manifest: UUID_OPERATION_MANIFEST,
  execute(input, options, context) {
    const operationId = UUID_OPERATION_MANIFEST.id;
    assertAllowedOptions(operationId, options, ["count"]);
    const count = optionalInteger(
      operationId,
      options,
      "count",
      1,
      MIN_UUID_COUNT,
      MAX_UUID_COUNT,
    );
    expectInputKind(operationId, input, "empty");
    checkpoint(context);
    const result = generateUuidV4(count);
    if (!result.ok) failFromCore(operationId, result.error);
    checkpoint(context);
    return { kind: "text", text: result.value.join("\n") };
  },
};

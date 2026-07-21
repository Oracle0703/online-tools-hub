import { MAX_DATE_MILLISECONDS } from "../../tools/timestamp-converter";
import { decodeJwt } from "../../tools/jwt-decoder";
import { JWT_OPERATION_MANIFEST } from "../catalog";
import type { OperationDefinition } from "../contract";
import {
  assertAllowedOptions,
  checkpoint,
  expectInputKind,
  failFromCore,
  optionalInteger,
} from "./_shared";

export const jwtOperationDefinition: OperationDefinition = {
  manifest: JWT_OPERATION_MANIFEST,
  execute(input, options, context) {
    const operationId = JWT_OPERATION_MANIFEST.id;
    assertAllowedOptions(operationId, options, ["nowMilliseconds"]);
    const nowMilliseconds = optionalInteger(
      operationId,
      options,
      "nowMilliseconds",
      Date.now(),
      -MAX_DATE_MILLISECONDS,
      MAX_DATE_MILLISECONDS,
    );
    const source = expectInputKind(operationId, input, "text").text;
    checkpoint(context);
    const result = decodeJwt(source, nowMilliseconds);
    if (!result.ok) failFromCore(operationId, result.error);
    checkpoint(context);
    return { kind: "text", text: JSON.stringify(result.value, null, 2) };
  },
};

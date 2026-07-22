import {
  parseRegexOperationInput,
  serializeRegexTestSuccess,
  testRegularExpression,
} from "../../tools/regex-tester";
import { REGEX_OPERATION_MANIFEST } from "../catalog";
import type { OperationDefinition } from "../contract";
import { OperationError } from "../errors";
import {
  assertAllowedOptions,
  checkpoint,
  expectInputKind,
  failFromCore,
} from "./_shared";

export const regexOperationDefinition: OperationDefinition = {
  manifest: REGEX_OPERATION_MANIFEST,
  execute(input, options, context) {
    const operationId = REGEX_OPERATION_MANIFEST.id;
    assertAllowedOptions(operationId, options, []);
    const payload = expectInputKind(operationId, input, "text");
    checkpoint(context);
    const parsed = parseRegexOperationInput(payload.text);
    if (!parsed) {
      throw new OperationError(
        "type-mismatch",
        "regex.test 需要只包含 pattern、flags 与 subject 的 JSON 对象。",
        { operationId },
      );
    }
    const result = testRegularExpression(parsed);
    if (!result.ok) {
      if (
        result.error.code === "pattern-too-large" ||
        result.error.code === "subject-too-large"
      ) {
        throw new OperationError("input-too-large", result.error.message, {
          operationId,
          details: {
            sourceCode: result.error.code,
            ...(result.error.field ? { field: result.error.field } : {}),
            ...(result.error.actual === undefined
              ? {}
              : { actual: result.error.actual }),
            ...(result.error.limit === undefined
              ? {}
              : { limit: result.error.limit }),
          },
        });
      }
      failFromCore(operationId, result.error);
    }
    checkpoint(context);
    return { kind: "text", text: serializeRegexTestSuccess(result) };
  },
};

import { diffTextLines } from "../../tools/text-diff";
import { TEXT_DIFF_OPERATION_MANIFEST } from "../catalog";
import type { OperationDefinition } from "../contract";
import { OperationError } from "../errors";
import {
  assertAllowedOptions,
  checkpoint,
  expectInputKind,
  failFromCore,
  optionalBoolean,
} from "./_shared";

export const textDiffOperationDefinition: OperationDefinition = {
  manifest: TEXT_DIFF_OPERATION_MANIFEST,
  execute(input, options, context) {
    const operationId = TEXT_DIFF_OPERATION_MANIFEST.id;
    assertAllowedOptions(operationId, options, [
      "ignoreWhitespace",
      "ignoreCase",
    ]);
    const ignoreWhitespace = optionalBoolean(
      operationId,
      options,
      "ignoreWhitespace",
      false,
    );
    const ignoreCase = optionalBoolean(
      operationId,
      options,
      "ignoreCase",
      false,
    );
    const pair = expectInputKind(operationId, input, "text-pair");
    checkpoint(context);
    const result = diffTextLines(pair.left, pair.right, {
      ignoreWhitespace,
      ignoreCase,
    });
    if (!result.ok) {
      if (result.error.code === "input-too-large") {
        throw new OperationError("input-too-large", result.error.message, {
          operationId,
          details: {
            sourceCode: result.error.code,
            ...(result.error.side ? { side: result.error.side } : {}),
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
    return { kind: "text", text: result.unified };
  },
};

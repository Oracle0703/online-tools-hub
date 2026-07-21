import { HashToolError, hashBytes, hashText } from "../../tools/hash-generator";
import { HASH_OPERATION_MANIFEST } from "../catalog";
import type { OperationDefinition } from "../contract";
import { OperationError } from "../errors";
import {
  assertAllowedOptions,
  checkpoint,
  mapThrownError,
  optionalEnum,
} from "./_shared";

export const hashOperationDefinition: OperationDefinition = {
  manifest: HASH_OPERATION_MANIFEST,
  async execute(input, options, context) {
    const operationId = HASH_OPERATION_MANIFEST.id;
    assertAllowedOptions(operationId, options, ["algorithm"]);
    const algorithm = optionalEnum(
      operationId,
      options,
      "algorithm",
      ["SHA-256", "SHA-512"] as const,
      "SHA-256",
    );

    if (input.kind !== "text" && input.kind !== "binary") {
      throw new OperationError(
        "type-mismatch",
        `${operationId} 需要 text 或 binary 输入，实际收到 ${input.kind}。`,
        {
          operationId,
          details: {
            expectedKinds: ["text", "binary"],
            actualKind: input.kind,
          },
        },
      );
    }

    const byteLength =
      input.kind === "text"
        ? new TextEncoder().encode(input.text).byteLength
        : input.data.byteLength;
    context.assertWorkingMemory(byteLength * 2);
    checkpoint(context);

    try {
      const text = await mapThrownError(operationId, () =>
        input.kind === "text"
          ? hashText(input.text, algorithm)
          : hashBytes(input.data, algorithm),
      );
      checkpoint(context);
      return { kind: "text", text };
    } catch (error) {
      if (
        error instanceof OperationError &&
        error.cause instanceof HashToolError &&
        error.cause.code === "input-too-large"
      ) {
        throw new OperationError("input-too-large", error.cause.message, {
          operationId,
          details: { sourceCode: error.cause.code },
          cause: error.cause,
        });
      }
      throw error;
    }
  },
};

import {
  exportQueryParametersJson,
  parseQueryInput,
  sortQueryParameters,
} from "../../tools/query-params";
import { QUERY_OPERATION_MANIFEST } from "../catalog";
import type { OperationDefinition } from "../contract";
import {
  assertAllowedOptions,
  checkpoint,
  expectInputKind,
  failFromCore,
  optionalBoolean,
  optionalEnum,
} from "./_shared";

export const queryOperationDefinition: OperationDefinition = {
  manifest: QUERY_OPERATION_MANIFEST,
  execute(input, options, context) {
    const operationId = QUERY_OPERATION_MANIFEST.id;
    assertAllowedOptions(operationId, options, ["encoding", "sort"]);
    const encoding = optionalEnum(
      operationId,
      options,
      "encoding",
      ["rfc3986", "form"] as const,
      "rfc3986",
    );
    const sort = optionalBoolean(operationId, options, "sort", false);
    const source = expectInputKind(operationId, input, "text").text;
    checkpoint(context);
    const result = parseQueryInput(source, { encoding });
    if (!result.ok) failFromCore(operationId, result.error);
    const parameters = sort
      ? sortQueryParameters(result.value.parameters)
      : result.value.parameters;
    checkpoint(context);
    return {
      kind: "text",
      text: exportQueryParametersJson(result.value, parameters, encoding),
    };
  },
};

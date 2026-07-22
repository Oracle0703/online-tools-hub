import {
  isRegexWorkerExecuteMessage,
  REGEX_WORKER_PROTOCOL_VERSION,
  type RegexWorkerResultMessage,
} from "../tools/regex-tester/contract";
import { installOperationWorkerPrivacyGuards } from "../operations/privacy-guard";

interface RegexWorkerScope {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(message: RegexWorkerResultMessage): void;
}

const workerScope = globalThis as unknown as RegexWorkerScope;

// GitHub Pages cannot attach a CSP response header to a module Worker. Block
// network, storage and other ambient capabilities before accepting a pattern.
installOperationWorkerPrivacyGuards(globalThis);
let acceptedTask = false;

workerScope.onmessage = (event) => {
  if (!isRegexWorkerExecuteMessage(event.data) || acceptedTask) return;
  acceptedTask = true;
  void executeTask(event.data.taskId, event.data.input);
};

async function executeTask(
  taskId: string,
  input: import("../tools/regex-tester/contract").RegexTestInput,
) {
  const { testRegularExpression } = await import("../tools/regex-tester/core");
  const response: RegexWorkerResultMessage = {
    type: "REGEX_TEST_RESULT",
    protocol: REGEX_WORKER_PROTOCOL_VERSION,
    taskId,
    result: testRegularExpression(input),
  };
  workerScope.postMessage(response);
}

export {};

import { describe, expect, it, vi } from "vitest";

import type {
  OperationDefinition,
  OperationManifest,
  OperationOutput,
} from "../../src/operations/contract";
import { OperationError } from "../../src/operations/errors";
import {
  installOperationWorkerRuntime,
  type OperationWorkerScope,
} from "../../src/operations/worker-runtime";
import {
  OPERATION_WORKER_PROTOCOL_VERSION,
  type OperationWorkerExecuteMessage,
  type OperationWorkerResponseMessage,
} from "../../src/operations/worker-protocol";

const manifest: OperationManifest = {
  version: 1,
  id: "fixture.worker",
  toolSlug: "json-formatter",
  inputKinds: ["text"],
  outputKinds: ["text", "binary"],
  maxInputBytes: 1024,
  maxOutputBytes: 1024,
  workingMemoryBytes: 1024,
  options: {
    additionalProperties: "forbidden",
    properties: {},
  },
  signatures: [
    {
      when: {},
      input: [{ kind: "text", contentType: "text/plain" }],
      output: { kind: "text", contentType: "text/plain" },
      determinism: "deterministic",
    },
  ],
  determinism: "deterministic",
  execution: {
    strategy: "worker",
    workerThresholdBytes: 0,
    timeoutMs: 1000,
  },
  capabilities: {
    network: "forbidden",
    persistence: "forbidden",
    environment: ["web-worker"],
  },
};

class FakeScope implements OperationWorkerScope {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  readonly messages: OperationWorkerResponseMessage[] = [];
  readonly transfers: Transferable[][] = [];

  postMessage(message: unknown, transfer: Transferable[] = []): void {
    this.messages.push(message as OperationWorkerResponseMessage);
    this.transfers.push([...transfer]);
  }

  dispatch(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent<unknown>);
  }
}

function request(
  taskId = "worker-task-1",
  operationId = manifest.id,
): OperationWorkerExecuteMessage {
  return {
    version: OPERATION_WORKER_PROTOCOL_VERSION,
    type: "execute",
    taskId,
    request: {
      operationId,
      input: { kind: "text", text: "private input" },
    },
  };
}

function definition(
  execute: OperationDefinition["execute"],
  definitionManifest = manifest,
): OperationDefinition {
  return { manifest: definitionManifest, execute };
}

function install(
  scope: FakeScope,
  overrides: Partial<{
    getManifest: (operationId: string) => OperationManifest | undefined;
    loadDefinition: (operationId: string) => Promise<OperationDefinition>;
  }> = {},
): void {
  installOperationWorkerRuntime(scope, {
    getManifest: (operationId) =>
      operationId === manifest.id ? manifest : undefined,
    loadDefinition: async () =>
      definition((input) => ({
        kind: "text",
        text: input.kind === "text" ? input.text : "unexpected",
      })),
    ...overrides,
  });
}

async function waitForMessages(scope: FakeScope, count: number): Promise<void> {
  await vi.waitFor(() => expect(scope.messages).toHaveLength(count));
}

describe("shared Operation Worker runtime", () => {
  it("validates, executes and transfers successful text and binary outputs", async () => {
    const textScope = new FakeScope();
    install(textScope);
    textScope.dispatch(request());
    await waitForMessages(textScope, 1);
    expect(textScope.messages[0]).toEqual({
      version: OPERATION_WORKER_PROTOCOL_VERSION,
      type: "success",
      taskId: "worker-task-1",
      output: { kind: "text", text: "private input" },
    });
    expect(textScope.transfers[0]).toEqual([]);

    const binaryScope = new FakeScope();
    const bytes = Uint8Array.from([1, 2, 3, 4]).buffer;
    install(binaryScope, {
      loadDefinition: async () =>
        definition(() => ({
          kind: "binary",
          data: bytes,
          mimeType: "application/octet-stream",
        })),
    });
    binaryScope.dispatch(request("worker-task-2"));
    await waitForMessages(binaryScope, 1);
    expect(binaryScope.messages[0]).toMatchObject({
      type: "success",
      taskId: "worker-task-2",
      output: { kind: "binary", mimeType: "application/octet-stream" },
    });
    expect(binaryScope.transfers[0]).toEqual([bytes]);
  });

  it("rejects malformed protocol records without consuming the one task slot", async () => {
    const scope = new FakeScope();
    install(scope);

    scope.dispatch(null);
    expect(scope.messages[0]).toMatchObject({
      type: "failure",
      taskId: "invalid-task",
      error: { code: "execution-failed" },
    });

    scope.dispatch({
      version: OPERATION_WORKER_PROTOCOL_VERSION,
      type: "execute",
      taskId: "recoverable-task",
      request: { operationId: manifest.id },
      extra: true,
    });
    expect(scope.messages[1]).toMatchObject({
      type: "failure",
      taskId: "recoverable-task",
      error: { code: "execution-failed" },
    });

    scope.dispatch(request("valid-after-malformed"));
    await waitForMessages(scope, 3);
    expect(scope.messages[2]).toMatchObject({
      type: "success",
      taskId: "valid-after-malformed",
    });
  });

  it("uses a fixed task id for hostile invalid messages", () => {
    const scope = new FakeScope();
    install(scope);
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("private proxy trap");
        },
        getOwnPropertyDescriptor() {
          throw new Error("private descriptor trap");
        },
      },
    );

    scope.dispatch(hostile);
    expect(scope.messages[0]).toMatchObject({
      type: "failure",
      taskId: "invalid-task",
      error: { code: "execution-failed" },
    });
    expect(JSON.stringify(scope.messages[0])).not.toContain("private");
  });

  it("accepts exactly one valid task even while its definition is pending", async () => {
    const scope = new FakeScope();
    let releaseDefinition!: (value: OperationDefinition) => void;
    const pendingDefinition = new Promise<OperationDefinition>((resolve) => {
      releaseDefinition = resolve;
    });
    install(scope, { loadDefinition: () => pendingDefinition });

    scope.dispatch(request("first-task"));
    scope.dispatch(request("second-task"));
    expect(scope.messages[0]).toMatchObject({
      type: "failure",
      taskId: "second-task",
      error: { code: "execution-failed" },
    });

    releaseDefinition(
      definition(() => ({ kind: "text", text: "first completed" })),
    );
    await waitForMessages(scope, 2);
    expect(scope.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "success",
          taskId: "first-task",
          output: { kind: "text", text: "first completed" },
        }),
      ]),
    );
  });

  it("fails unknown requests before invoking a definition loader", async () => {
    const scope = new FakeScope();
    const loadDefinition = vi.fn<() => Promise<OperationDefinition>>();
    install(scope, {
      getManifest: () => undefined,
      loadDefinition,
    });

    scope.dispatch(request("unknown-task", "unknown.operation"));
    await waitForMessages(scope, 1);
    expect(scope.messages[0]).toMatchObject({
      type: "failure",
      taskId: "unknown-task",
      error: { code: "unknown-operation" },
    });
    expect(loadDefinition).not.toHaveBeenCalled();
  });

  it("rejects a data-only request with no Operation ID before manifest lookup", async () => {
    const scope = new FakeScope();
    const getManifest =
      vi.fn<(operationId: string) => OperationManifest | undefined>();
    const loadDefinition = vi.fn<() => Promise<OperationDefinition>>();
    install(scope, { getManifest, loadDefinition });

    scope.dispatch({
      version: OPERATION_WORKER_PROTOCOL_VERSION,
      type: "execute",
      taskId: "missing-operation-id",
      request: {},
    });
    await waitForMessages(scope, 1);
    expect(scope.messages[0]).toMatchObject({
      type: "failure",
      taskId: "missing-operation-id",
      error: { code: "unknown-operation" },
    });
    expect(getManifest).not.toHaveBeenCalled();
    expect(loadDefinition).not.toHaveBeenCalled();
  });

  it("rejects loader mismatches and invalid outputs at the Worker boundary", async () => {
    const mismatchScope = new FakeScope();
    install(mismatchScope, {
      loadDefinition: async () =>
        definition(() => ({ kind: "text", text: "unused" }), {
          ...manifest,
          id: "different.operation",
        }),
    });
    mismatchScope.dispatch(request("mismatch-task"));
    await waitForMessages(mismatchScope, 1);
    expect(mismatchScope.messages[0]).toMatchObject({
      type: "failure",
      error: {
        code: "execution-failed",
        operationId: manifest.id,
      },
    });

    const outputScope = new FakeScope();
    install(outputScope, {
      loadDefinition: async () =>
        definition(
          () => ({ kind: "text", text: "x".repeat(2048) }) as OperationOutput,
        ),
    });
    outputScope.dispatch(request("invalid-output-task"));
    await waitForMessages(outputScope, 1);
    expect(outputScope.messages[0]).toMatchObject({
      type: "failure",
      error: { code: "output-too-large", operationId: manifest.id },
    });
  });

  it("keeps canonical errors and sanitizes unexpected implementation failures", async () => {
    const canonicalScope = new FakeScope();
    install(canonicalScope, {
      loadDefinition: async () =>
        definition((_input, _options, context) => {
          context.assertWorkingMemory(manifest.workingMemoryBytes + 1);
          return { kind: "text", text: "unreachable" };
        }),
    });
    canonicalScope.dispatch(request("memory-task"));
    await waitForMessages(canonicalScope, 1);
    expect(canonicalScope.messages[0]).toMatchObject({
      type: "failure",
      error: { code: "memory-budget", operationId: manifest.id },
    });

    const unexpectedScope = new FakeScope();
    install(unexpectedScope, {
      loadDefinition: async () =>
        definition(() => {
          throw new Error("PRIVATE_RUNTIME_CAUSE");
        }),
    });
    unexpectedScope.dispatch(request("unexpected-task"));
    await waitForMessages(unexpectedScope, 1);
    expect(unexpectedScope.messages[0]).toMatchObject({
      type: "failure",
      taskId: "unexpected-task",
      error: {
        code: "execution-failed",
        operationId: manifest.id,
        message: "Operation execution failed.",
      },
    });
    expect(JSON.stringify(unexpectedScope.messages[0])).not.toContain(
      "PRIVATE_RUNTIME_CAUSE",
    );
  });

  it("passes normalized options and a live Worker execution context", async () => {
    const scope = new FakeScope();
    install(scope, {
      loadDefinition: async () =>
        definition((input, options, context) => {
          expect(input).toEqual({ kind: "text", text: "private input" });
          expect(options).toEqual({});
          expect(context.location).toBe("worker");
          expect(context.signal).toBeInstanceOf(AbortSignal);
          expect(context.signal.aborted).toBe(false);
          expect(context.checkCancelled()).toBeUndefined();
          return { kind: "text", text: "context ready" };
        }),
    });

    scope.dispatch(request("context-task"));
    await waitForMessages(scope, 1);
    expect(scope.messages[0]).toMatchObject({
      type: "success",
      taskId: "context-task",
      output: { kind: "text", text: "context ready" },
    });
  });

  it("preserves canonical OperationError details without exposing its cause", async () => {
    const scope = new FakeScope();
    install(scope, {
      loadDefinition: async () =>
        definition(() => {
          throw new OperationError("cancelled", "Operation was cancelled.", {
            operationId: manifest.id,
            details: { phase: "fixture" },
            cause: new Error("PRIVATE_CANCEL_CAUSE"),
          });
        }),
    });
    scope.dispatch(request("canonical-task"));
    await waitForMessages(scope, 1);
    expect(scope.messages[0]).toMatchObject({
      type: "failure",
      error: {
        code: "cancelled",
        operationId: manifest.id,
        details: { phase: "fixture" },
      },
    });
    expect(JSON.stringify(scope.messages[0])).not.toContain(
      "PRIVATE_CANCEL_CAUSE",
    );
  });
});

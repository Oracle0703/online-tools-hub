import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MAX_WORKFLOW_RECIPE_BYTES,
  WORKFLOW_RECIPE_FORMAT,
} from "../../src/workflows/contract";
import {
  WORKFLOW_RECIPE_DOWNLOAD_FILENAME,
  WorkflowRecipeFileError,
  downloadWorkflowRecipeFile,
  readWorkflowRecipeFile,
  type WorkflowRecipeDownloadEnvironment,
} from "../../src/workflows/recipe-file";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function jsonFile(value: unknown, name = "private-name.json"): File {
  return new File([JSON.stringify(value)], name, { type: "application/json" });
}

function recipe(
  operationId = "json.transform",
  options: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    format: WORKFLOW_RECIPE_FORMAT,
    version: 1,
    steps: [{ operationId, options }],
  };
}

function expectFileError(error: unknown, code: string): boolean {
  expect(error).toBeInstanceOf(WorkflowRecipeFileError);
  expect(error).toMatchObject({ code });
  return true;
}

function changedFile(
  bytes: Uint8Array,
  declaredSize: number,
  name = "never-retain-this.json",
): File {
  const file = new File([bytes.slice().buffer as ArrayBuffer], name);
  Object.defineProperty(file, "size", {
    configurable: true,
    value: declaredSize,
  });
  Object.defineProperty(file, "arrayBuffer", {
    configurable: true,
    value: async () => bytes.slice().buffer,
  });
  return file;
}

describe("workflow recipe file import", () => {
  it("strictly parses, catalog-compiles and canonically exports recipe v1", async () => {
    const file = jsonFile({
      steps: [{ options: {}, operationId: "json.transform" }],
      version: 1,
      format: WORKFLOW_RECIPE_FORMAT,
    });

    const imported = await readWorkflowRecipeFile(file);

    expect(imported.canonical).toBe(
      '{"format":"online-tools-hub/workflow","version":1,"steps":[{"operationId":"json.transform","options":{"indent":2,"mode":"format"}}]}',
    );
    expect(imported.recipe.steps[0]?.options).toEqual({
      indent: 2,
      mode: "format",
    });
    expect(Object.isFrozen(imported)).toBe(true);
    expect(Object.isFrozen(imported.recipe)).toBe(true);
    expect(JSON.stringify(imported)).not.toContain(file.name);
  });

  it.each([
    [new File([], "empty.json"), "empty-file"],
    [
      new File([new Uint8Array(MAX_WORKFLOW_RECIPE_BYTES + 1)], "large.json"),
      "file-too-large",
    ],
    [changedFile(new Uint8Array([1]), Number.NaN), "invalid-file"],
    [changedFile(new Uint8Array([1]), -1), "invalid-file"],
    [changedFile(new Uint8Array([1]), 1.5), "invalid-file"],
    [
      changedFile(new Uint8Array([1]), Number.MAX_SAFE_INTEGER + 1),
      "invalid-file",
    ],
  ] as const)("rejects unsafe declared size %#", async (file, code) => {
    await expect(readWorkflowRecipeFile(file)).rejects.toSatisfy(
      (error: unknown) => expectFileError(error, code),
    );
  });

  it("rejects non-Files and size getters that cannot be inspected", async () => {
    await expect(
      readWorkflowRecipeFile({ size: 1, arrayBuffer: vi.fn() } as never),
    ).rejects.toSatisfy((error: unknown) =>
      expectFileError(error, "invalid-file"),
    );

    const file = new File(["x"], "private.json");
    Object.defineProperty(file, "size", {
      configurable: true,
      get() {
        throw new Error("private-size-error");
      },
    });
    await expect(readWorkflowRecipeFile(file)).rejects.toSatisfy(
      (error: unknown) => expectFileError(error, "invalid-file"),
    );
  });

  it("checks the actual ArrayBuffer length after reading", async () => {
    await expect(
      readWorkflowRecipeFile(changedFile(new Uint8Array([1, 2]), 3)),
    ).rejects.toSatisfy((error: unknown) =>
      expectFileError(error, "invalid-file"),
    );
    await expect(
      readWorkflowRecipeFile(
        changedFile(new Uint8Array(MAX_WORKFLOW_RECIPE_BYTES + 1), 1),
      ),
    ).rejects.toSatisfy((error: unknown) =>
      expectFileError(error, "file-too-large"),
    );
    await expect(
      readWorkflowRecipeFile(changedFile(new Uint8Array(), 1)),
    ).rejects.toSatisfy((error: unknown) =>
      expectFileError(error, "empty-file"),
    );
  });

  it("canonicalizes read failures without retaining names or lower errors", async () => {
    const file = new File(["x"], "private-canary.json");
    Object.defineProperty(file, "arrayBuffer", {
      configurable: true,
      value: () => Promise.reject(new Error("private-body-canary")),
    });

    let caught: unknown;
    try {
      await readWorkflowRecipeFile(file);
    } catch (error) {
      caught = error;
    }
    expectFileError(caught, "read-failed");
    expect(JSON.stringify(caught)).not.toMatch(
      /private-canary|private-body-canary/u,
    );

    const wrongBuffer = new File(["x"], "wrong.json");
    Object.defineProperty(wrongBuffer, "arrayBuffer", {
      configurable: true,
      value: async () => new Uint8Array([1]) as never,
    });
    await expect(readWorkflowRecipeFile(wrongBuffer)).rejects.toSatisfy(
      (error: unknown) => expectFileError(error, "read-failed"),
    );
  });

  it("requires fatal UTF-8 decoding", async () => {
    const invalidUtf8 = changedFile(Uint8Array.from([0xc3, 0x28]), 2);
    await expect(readWorkflowRecipeFile(invalidUtf8)).rejects.toSatisfy(
      (error: unknown) => expectFileError(error, "invalid-text"),
    );
  });

  it.each([
    ["not json"],
    [JSON.stringify({ ...recipe(), version: 2 })],
    [JSON.stringify(recipe("missing.operation"))],
    [JSON.stringify(recipe("json.transform", { mode: "private-mode" }))],
    [JSON.stringify({ ...recipe(), payload: "private-body-canary" })],
  ])(
    "fails closed for malformed, future or catalog-invalid recipes",
    async (source) => {
      let caught: unknown;
      try {
        await readWorkflowRecipeFile(new File([source], "secret-name.json"));
      } catch (error) {
        caught = error;
      }

      expectFileError(caught, "invalid-recipe");
      expect(JSON.stringify(caught)).not.toMatch(
        /secret-name|private-body|private-mode|missing\.operation/u,
      );
    },
  );
});

describe("workflow recipe file download", () => {
  function environment() {
    const scheduled: Array<() => void> = [];
    const createObjectUrl = vi.fn((blob: Blob): string => {
      expect(blob).toBeInstanceOf(Blob);
      return "blob:recipe";
    });
    const revokeObjectUrl = vi.fn();
    const triggerDownload = vi.fn();
    const schedule = vi.fn((callback: () => void, delayMs: number) => {
      expect(delayMs).toBe(0);
      scheduled.push(callback);
    });
    const value: WorkflowRecipeDownloadEnvironment = {
      createObjectUrl,
      revokeObjectUrl,
      triggerDownload,
      schedule,
    };
    return {
      value,
      scheduled,
      createObjectUrl,
      revokeObjectUrl,
      triggerDownload,
      schedule,
    };
  }

  it("downloads only canonical v1 JSON under a fixed filename", async () => {
    const runtime = environment();
    downloadWorkflowRecipeFile(recipe(), runtime.value);

    expect(runtime.createObjectUrl).toHaveBeenCalledOnce();
    const blob = runtime.createObjectUrl.mock.calls[0]?.[0];
    expect(blob).toBeInstanceOf(Blob);
    expect(blob?.type).toBe("application/json;charset=utf-8");
    expect(await blob?.text()).toBe(
      '{"format":"online-tools-hub/workflow","version":1,"steps":[{"operationId":"json.transform","options":{"indent":2,"mode":"format"}}]}',
    );
    expect(runtime.triggerDownload).toHaveBeenCalledWith(
      "blob:recipe",
      WORKFLOW_RECIPE_DOWNLOAD_FILENAME,
    );
    expect(runtime.revokeObjectUrl).not.toHaveBeenCalled();
    expect(runtime.scheduled).toHaveLength(1);
    runtime.scheduled[0]?.();
    expect(runtime.revokeObjectUrl).toHaveBeenCalledWith("blob:recipe");
  });

  it("uses the browser click path and removes its transient anchor", () => {
    const scheduled: Array<() => void> = [];
    const link = {
      href: "",
      download: "",
      rel: "",
      click: vi.fn(),
      remove: vi.fn(),
    };
    const body = { append: vi.fn() };
    const createElement = vi.fn(() => link);
    const createObjectURL = vi.fn(() => "blob:default-recipe");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("document", { body, createElement });
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
    vi.stubGlobal(
      "setTimeout",
      vi.fn((callback: () => void, delayMs: number) => {
        expect(delayMs).toBe(0);
        scheduled.push(callback);
        return 1;
      }),
    );

    downloadWorkflowRecipeFile(recipe());

    expect(createElement).toHaveBeenCalledWith("a");
    expect(body.append).toHaveBeenCalledWith(link);
    expect(link).toMatchObject({
      href: "blob:default-recipe",
      download: WORKFLOW_RECIPE_DOWNLOAD_FILENAME,
      rel: "noopener",
    });
    expect(link.click).toHaveBeenCalledOnce();
    expect(link.remove).toHaveBeenCalledOnce();
    scheduled[0]?.();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:default-recipe");
  });

  it("still schedules revocation when the click fails", () => {
    const runtime = environment();
    runtime.triggerDownload.mockImplementation(() => {
      throw new Error("private-browser-error");
    });

    expect(() => downloadWorkflowRecipeFile(recipe(), runtime.value)).toThrow(
      expect.objectContaining({ code: "download-unavailable" }),
    );
    expect(runtime.scheduled).toHaveLength(1);
    runtime.scheduled[0]?.();
    expect(runtime.revokeObjectUrl).toHaveBeenCalledWith("blob:recipe");
  });

  it("revokes synchronously if zero-delay scheduling fails", () => {
    const runtime = environment();
    runtime.schedule.mockImplementation(() => {
      throw new Error("scheduler unavailable");
    });
    runtime.revokeObjectUrl.mockImplementation(() => {
      throw new Error("revocation detail");
    });

    expect(() =>
      downloadWorkflowRecipeFile(recipe(), runtime.value),
    ).not.toThrow();
    expect(runtime.revokeObjectUrl).toHaveBeenCalledWith("blob:recipe");
  });

  it("does not create a URL for invalid recipes or expose browser errors", () => {
    const runtime = environment();
    expect(() =>
      downloadWorkflowRecipeFile(recipe("missing.operation"), runtime.value),
    ).toThrow(expect.objectContaining({ code: "invalid-recipe" }));
    expect(runtime.createObjectUrl).not.toHaveBeenCalled();

    runtime.createObjectUrl.mockImplementation(() => {
      throw new Error("private-browser-canary");
    });
    let caught: unknown;
    try {
      downloadWorkflowRecipeFile(recipe(), runtime.value);
    } catch (error) {
      caught = error;
    }
    expectFileError(caught, "download-unavailable");
    expect(JSON.stringify(caught)).not.toContain("private-browser-canary");
    expect(runtime.revokeObjectUrl).not.toHaveBeenCalled();
  });

  it("fails closed and attempts cleanup for an invalid object URL", () => {
    const runtime = environment();
    runtime.createObjectUrl.mockReturnValue("");

    expect(() => downloadWorkflowRecipeFile(recipe(), runtime.value)).toThrow(
      expect.objectContaining({ code: "download-unavailable" }),
    );
    expect(runtime.triggerDownload).not.toHaveBeenCalled();
    expect(runtime.scheduled).toHaveLength(1);
    runtime.scheduled[0]?.();
    expect(runtime.revokeObjectUrl).toHaveBeenCalledWith("");
  });

  it("rejects missing browser support with a stable error", () => {
    expect(() => downloadWorkflowRecipeFile(recipe())).toThrow(
      expect.objectContaining({ code: "download-unavailable" }),
    );
  });
});

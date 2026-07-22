import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Download, type Page } from "@playwright/test";

import {
  MAX_WORKFLOW_RECIPE_LIBRARY_ENTRIES,
  WORKFLOW_RECIPE_LIBRARY_FORMAT,
  WORKFLOW_RECIPE_LIBRARY_STORAGE_KEY,
  WORKFLOW_RECIPE_LIBRARY_VERSION,
} from "../../src/lib/workflow-recipe-library";
import { MAX_WORKFLOW_RECIPE_BYTES } from "../../src/workflows/contract";
import { exportWorkflowRecipeCanonical } from "../../src/workflows/recipe-codec";
import { WORKFLOW_RECIPE_DOWNLOAD_FILENAME } from "../../src/workflows/recipe-file";
import { getWorkflowTemplate } from "../../src/workflows/templates";

type BrowserPrivacyProbe = {
  clipboardWrites: string[];
  createdBlobUrls: string[];
  revokedBlobUrls: string[];
  activeBlobUrls: Set<string>;
};

type StoredRecipeLibraryEnvelope = {
  format: string;
  version: number;
  items: Array<{
    id: string;
    updatedAt: number;
    recipe: {
      format: string;
      version: number;
      steps: Array<{
        operationId: string;
        options: Record<string, unknown>;
      }>;
    };
  }>;
};

async function installPrivacyProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const nativeCreateObjectUrl = URL.createObjectURL.bind(URL);
    const nativeRevokeObjectUrl = URL.revokeObjectURL.bind(URL);
    const probe: BrowserPrivacyProbe = {
      clipboardWrites: [],
      createdBlobUrls: [],
      revokedBlobUrls: [],
      activeBlobUrls: new Set<string>(),
    };
    const clipboard = {
      async read() {
        throw new Error("Unexpected clipboard read");
      },
      async readText() {
        throw new Error("Unexpected clipboard read");
      },
      async write() {},
      async writeText(value: string) {
        probe.clipboardWrites.push(value);
      },
    };

    try {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: clipboard,
      });
    } catch {
      Object.defineProperty(Object.getPrototypeOf(navigator), "clipboard", {
        configurable: true,
        value: clipboard,
      });
    }

    URL.createObjectURL = (object: Blob | MediaSource): string => {
      const objectUrl = nativeCreateObjectUrl(object);
      probe.createdBlobUrls.push(objectUrl);
      probe.activeBlobUrls.add(objectUrl);
      return objectUrl;
    };
    URL.revokeObjectURL = (objectUrl: string): void => {
      probe.revokedBlobUrls.push(objectUrl);
      probe.activeBlobUrls.delete(objectUrl);
      nativeRevokeObjectUrl(objectUrl);
    };
    Object.defineProperty(globalThis, "__recipeLibraryPrivacyProbe", {
      configurable: true,
      value: probe,
    });
  });
}

async function privacyProbe(page: Page): Promise<{
  clipboardWrites: string[];
  createdBlobUrls: string[];
  revokedBlobUrls: string[];
  activeBlobUrls: string[];
}> {
  return page.evaluate(() => {
    const probe = (
      globalThis as typeof globalThis & {
        __recipeLibraryPrivacyProbe?: BrowserPrivacyProbe;
      }
    ).__recipeLibraryPrivacyProbe;
    if (probe === undefined) throw new Error("Recipe privacy probe missing");
    return {
      clipboardWrites: [...probe.clipboardWrites],
      createdBlobUrls: [...probe.createdBlobUrls],
      revokedBlobUrls: [...probe.revokedBlobUrls],
      activeBlobUrls: [...probe.activeBlobUrls],
    };
  });
}

async function downloadBytes(download: Download): Promise<Buffer> {
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function openBlankStudio(page: Page): Promise<void> {
  await page.goto("./workflows/new/", { waitUntil: "networkidle" });
  await expect(page.locator("[data-workflow-studio]")).toBeVisible();
  await expect(page.locator("[data-workflow-empty]")).toBeVisible();
  await expect(page.locator("[data-workflow-recipe-library]")).toBeVisible();
}

async function openLibrary(page: Page, keyboard = false): Promise<void> {
  const library = page.locator("[data-workflow-recipe-library]");
  const isOpen = await library.evaluate(
    (element) => (element as HTMLDetailsElement).open,
  );
  if (!isOpen) {
    const summary = library.locator("summary");
    if (keyboard) {
      await summary.focus();
      await page.keyboard.press("Enter");
    } else {
      await summary.click();
    }
  }
  await expect(library).toHaveAttribute("open", "");
}

async function addOperation(
  page: Page,
  query: string,
  operationId: string,
  keyboard = false,
): Promise<void> {
  await page.locator("[data-operation-search]").fill(query);
  await expect(page.locator("[data-add-operation-select]")).toHaveValue(
    operationId,
  );
  const add = page.locator('[data-action="add-step"]');
  if (keyboard) {
    await add.focus();
    await page.keyboard.press("Enter");
  } else {
    await add.click();
  }
  await expect(page.locator("[data-workflow-step]").last()).toHaveAttribute(
    "data-operation-id",
    operationId,
  );
}

async function buildTwoStepCustomRecipe(
  page: Page,
  keyboard = false,
): Promise<void> {
  await addOperation(page, "base64.codec", "base64.codec", keyboard);
  const firstStep = page.locator("[data-workflow-step]").first();
  await firstStep
    .locator('[data-option-name="mode"] select')
    .selectOption({ label: "decode" });
  await firstStep
    .locator('[data-option-name="decodedContentType"] select')
    .selectOption({ label: "application/json" });
  await addOperation(page, "json.transform", "json.transform", keyboard);
  await expect(page.locator("[data-workflow-studio]")).toHaveAttribute(
    "data-step-count",
    "2",
  );
  await expect(page.locator("[data-recipe-valid]")).toHaveAttribute(
    "data-recipe-valid",
    "true",
  );
}

async function saveCurrentRecipe(page: Page, keyboard = false): Promise<void> {
  await openLibrary(page, keyboard);
  const save = page.locator('[data-action="save-library-recipe"]');
  await expect(save).toBeEnabled();
  if (keyboard) {
    await save.focus();
    await page.keyboard.press("Enter");
  } else {
    await save.click();
  }
  await expect(page.locator("[data-library-entry]")).toHaveCount(1);
}

async function serializedLibrary(page: Page): Promise<string | null> {
  return page.evaluate(
    (key) => localStorage.getItem(key),
    WORKFLOW_RECIPE_LIBRARY_STORAGE_KEY,
  );
}

async function parsedLibrary(page: Page): Promise<StoredRecipeLibraryEnvelope> {
  const serialized = await serializedLibrary(page);
  if (serialized === null) throw new Error("Recipe library was not persisted");
  return JSON.parse(serialized) as StoredRecipeLibraryEnvelope;
}

function expectExactEnvelope(envelope: StoredRecipeLibraryEnvelope): void {
  expect(Object.keys(envelope).sort()).toEqual(["format", "items", "version"]);
  expect(envelope.format).toBe(WORKFLOW_RECIPE_LIBRARY_FORMAT);
  expect(envelope.version).toBe(WORKFLOW_RECIPE_LIBRARY_VERSION);
  expect(envelope.items).toHaveLength(1);

  const item = envelope.items[0];
  if (item === undefined) throw new Error("Recipe entry missing");
  expect(Object.keys(item).sort()).toEqual(["id", "recipe", "updatedAt"]);
  expect(item.id).toMatch(/^recipe-[a-z0-9-]+$/u);
  expect(Number.isSafeInteger(item.updatedAt)).toBe(true);
  expect(Object.keys(item.recipe).sort()).toEqual([
    "format",
    "steps",
    "version",
  ]);
  expect(item.recipe.steps).toHaveLength(2);
  for (const step of item.recipe.steps) {
    expect(Object.keys(step).sort()).toEqual(["operationId", "options"]);
  }
  expect(item.recipe.steps.map((step) => step.operationId)).toEqual([
    "base64.codec",
    "json.transform",
  ]);
}

function privateRepresentations(value: string): string[] {
  const base64 = Buffer.from(value, "utf8").toString("base64");
  return [
    value,
    encodeURI(value),
    encodeURIComponent(value),
    base64,
    Buffer.from(value, "utf8").toString("base64url"),
    createHash("sha256").update(value).digest("hex"),
  ];
}

async function browserPrivateState(page: Page): Promise<string> {
  return page.evaluate(() =>
    JSON.stringify({
      href: location.href,
      historyState: history.state,
      localStorage: Object.entries(localStorage),
      sessionStorage: Object.entries(sessionStorage),
    }),
  );
}

test("保存两步自定义配方时只持久化精确 envelope，刷新不恢复正文或运行态", async ({
  page,
}) => {
  await installPrivacyProbe(page);
  const consoleEntries: string[] = [];
  page.on("console", (message) => consoleEntries.push(message.text()));
  page.on("pageerror", (error) => consoleEntries.push(error.message));

  await openBlankStudio(page);
  await buildTwoStepCustomRecipe(page);

  const canary = "OTH_RECIPE_PRIVATE_中文🙂?&=f71d";
  const input = Buffer.from(
    JSON.stringify({ secret: canary, nested: { private: true } }),
    "utf8",
  ).toString("base64");
  const representations = [
    ...privateRepresentations(canary),
    ...privateRepresentations(input),
  ];
  const initialUrl = page.url();

  await page.locator("[data-workflow-input]").fill(input);
  await page.locator('[data-action="run"]').click();
  await expect(page.locator("[data-workflow-studio]")).toHaveAttribute(
    "data-runtime-status",
    "succeeded",
    { timeout: 30_000 },
  );
  await expect(page.locator("[data-step-preview]").last()).toContainText(
    canary,
  );

  const recipePanel = page.locator(".workflow-studio__recipe-panel");
  await recipePanel.locator("summary").click();
  await page
    .locator("[data-recipe-import]")
    .fill(`{"privateDraft":"${canary}"}`);
  await page.locator('[data-action="export-recipe"]').click();
  await expect(page.locator("[data-recipe-export]")).not.toHaveValue("");

  await saveCurrentRecipe(page);
  const firstEnvelope = await parsedLibrary(page);
  expectExactEnvelope(firstEnvelope);
  const firstId = firstEnvelope.items[0]!.id;

  await page.locator('[data-action="save-library-recipe"]').click();
  await expect(page.locator("[data-library-entry]")).toHaveCount(1);
  const deduplicated = await parsedLibrary(page);
  expect(deduplicated.items).toHaveLength(1);
  expect(deduplicated.items[0]!.id).toBe(firstId);

  for (const representation of representations) {
    expect(await browserPrivateState(page)).not.toContain(representation);
    expect(consoleEntries.join("\n")).not.toContain(representation);
  }
  expect(page.url()).toBe(initialUrl);

  await page.reload({ waitUntil: "networkidle" });
  await expect(page.locator("[data-library-entry]")).toHaveCount(1);
  await expect(page.locator("[data-workflow-studio]")).toHaveAttribute(
    "data-template-id",
    "custom",
  );
  await expect(page.locator("[data-workflow-studio]")).toHaveAttribute(
    "data-runtime-status",
    "idle",
  );
  await expect(page.locator("[data-workflow-step]")).toHaveCount(0);
  await expect(page.locator("[data-step-preview]")).toHaveCount(0);

  await openLibrary(page);
  await page.locator('[data-library-action="load"]').click();
  await expect(page.locator("[data-workflow-step]")).toHaveCount(2);
  await expect(page.locator("[data-workflow-input]")).toHaveValue("");

  await page.locator("[data-workflow-input]").fill(input);
  await page.locator('[data-action="run"]').click();
  await expect(page.locator("[data-workflow-studio]")).toHaveAttribute(
    "data-runtime-status",
    "succeeded",
    { timeout: 30_000 },
  );
  await page.locator("[data-batch-file-input]").setInputFiles({
    name: "queued-private-source.txt",
    mimeType: "text/plain",
    buffer: Buffer.from(input, "utf8"),
  });
  await expect(page.locator("[data-batch-item]")).toHaveCount(1);
  await page.locator(".workflow-studio__recipe-panel summary").click();
  await page.locator("[data-recipe-import]").fill('{"temporary":true}');
  await page.locator('[data-action="export-recipe"]').click();
  await expect(page.locator("[data-recipe-export]")).not.toHaveValue("");

  await page.locator('[data-library-action="load"]').click();
  await expect(page.locator("[data-workflow-studio]")).toHaveAttribute(
    "data-runtime-status",
    "idle",
  );
  await expect(page.locator("[data-workflow-input]")).toHaveValue("");
  await expect(page.locator("[data-step-preview]")).toHaveCount(0);
  await expect(page.locator("[data-batch-item]")).toHaveCount(0);
  await expect(page.locator("[data-recipe-import]")).toHaveValue("");
  await expect(page.locator("[data-recipe-export]")).toHaveValue("");
  await expect(page.getByText("queued-private-source.txt")).toHaveCount(0);

  for (const representation of representations) {
    expect(await browserPrivateState(page)).not.toContain(representation);
    expect(consoleEntries.join("\n")).not.toContain(representation);
  }
  expect(page.url()).toBe(initialUrl);
  expect((await privacyProbe(page)).clipboardWrites).toEqual([]);
});

test("断网后仍可载入、复制和下载规范化配方，Blob URL 会由零延迟任务释放", async ({
  context,
  page,
}) => {
  await installPrivacyProbe(page);
  await openBlankStudio(page);
  await buildTwoStepCustomRecipe(page);
  await saveCurrentRecipe(page);

  const envelope = await parsedLibrary(page);
  const storedRecipe = envelope.items[0]?.recipe;
  if (storedRecipe === undefined) throw new Error("Stored recipe missing");
  const canonical = exportWorkflowRecipeCanonical(storedRecipe);

  await context.setOffline(true);
  try {
    await page.locator('[data-action="save-library-recipe"]').click();
    await expect(page.locator("[data-library-entry]")).toHaveCount(1);
    await expect(
      page.locator("[data-library-feedback='success']"),
    ).toContainText("已保存纯配方");

    await page.locator('[data-library-action="load"]').click();
    await expect(page.locator("[data-workflow-step]")).toHaveCount(2);

    await page.locator('[data-library-action="copy"]').click();
    await expect
      .poll(async () => (await privacyProbe(page)).clipboardWrites)
      .toEqual([canonical]);

    const downloadPromise = page.waitForEvent("download");
    await page.locator('[data-library-action="download"]').click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe(
      WORKFLOW_RECIPE_DOWNLOAD_FILENAME,
    );
    expect((await downloadBytes(download)).toString("utf8")).toBe(canonical);

    await expect
      .poll(async () => {
        const probe = await privacyProbe(page);
        return {
          created: probe.createdBlobUrls.length,
          revoked: probe.revokedBlobUrls.length,
          active: probe.activeBlobUrls,
        };
      })
      .toEqual({ created: 1, revoked: 1, active: [] });
  } finally {
    await context.setOffline(false);
  }
});

test("损坏的外部 envelope 不会被静默覆盖，只有明确清空后才恢复持久化", async ({
  page,
}) => {
  const corruptEnvelope =
    '{"format":"online-tools-hub/workflow-recipe-library","version":99,"items":[]}';
  await page.addInitScript(
    ({ key, corrupt }) => {
      try {
        localStorage.setItem(key, corrupt);
      } catch {
        // The about:blank bootstrap has no storage origin; the target page does.
      }
    },
    {
      key: WORKFLOW_RECIPE_LIBRARY_STORAGE_KEY,
      corrupt: corruptEnvelope,
    },
  );

  await openBlankStudio(page);
  await buildTwoStepCustomRecipe(page);
  await saveCurrentRecipe(page);
  await expect(page.locator(".workflow-recipe-library__memory")).toContainText(
    "当前为内存模式",
  );
  await expect(page.locator("[data-library-entry]")).toHaveCount(1);
  expect(await serializedLibrary(page)).toBe(corruptEnvelope);

  const clear = page.locator('[data-library-action="clear"]');
  await clear.click();
  await expect(clear).toHaveText("确认清空");
  expect(await serializedLibrary(page)).toBe(corruptEnvelope);
  await clear.click();
  await expect(page.locator("[data-library-entry]")).toHaveCount(0);
  expect(await serializedLibrary(page)).toBeNull();

  await page.locator('[data-action="save-library-recipe"]').click();
  await expect(page.locator("[data-library-entry]")).toHaveCount(1);
  const recovered = await parsedLibrary(page);
  expectExactEnvelope(recovered);
});

test("文件导入严格失败关闭且不污染已有配方，删除与二次确认清空可回收状态", async ({
  page,
}) => {
  await openBlankStudio(page);
  await openLibrary(page);

  const firstTemplate = getWorkflowTemplate("encoded-callback-query-audit");
  const secondTemplate = getWorkflowTemplate("encoded-jwt-claims");
  if (firstTemplate === undefined || secondTemplate === undefined) {
    throw new Error("Workflow fixtures missing");
  }
  const firstCanonical = exportWorkflowRecipeCanonical(firstTemplate.recipe);
  const secondCanonical = exportWorkflowRecipeCanonical(secondTemplate.recipe);
  const fileInput = page.locator("[data-library-file-input]");

  await fileInput.setInputFiles({
    name: "PRIVATE_IMPORTED_FILENAME_SHOULD_DISAPPEAR.json",
    mimeType: "application/json",
    buffer: Buffer.from(firstCanonical, "utf8"),
  });
  await expect(page.locator("[data-library-feedback='success']")).toContainText(
    "安全导入",
  );
  await expect(page.locator("[data-library-entry]")).toHaveCount(1);
  await expect(
    page.getByText("PRIVATE_IMPORTED_FILENAME_SHOULD_DISAPPEAR.json"),
  ).toHaveCount(0);

  const knownGood = await serializedLibrary(page);
  if (knownGood === null) throw new Error("Imported recipe was not stored");
  const invalidCandidates = [
    {
      name: "invalid.json",
      body: Buffer.from("not-json", "utf8"),
    },
    {
      name: "future.json",
      body: Buffer.from(
        JSON.stringify({ ...JSON.parse(firstCanonical), version: 2 }),
        "utf8",
      ),
    },
    {
      name: "oversize.json",
      body: Buffer.alloc(MAX_WORKFLOW_RECIPE_BYTES + 1, 0x78),
    },
  ];

  for (const candidate of invalidCandidates) {
    await fileInput.setInputFiles({
      name: candidate.name,
      mimeType: "application/json",
      buffer: candidate.body,
    });
    await expect(page.locator("[data-library-feedback='error']")).toContainText(
      "文件未导入",
    );
    await expect(page.locator("[data-library-entry]")).toHaveCount(1);
    expect(await serializedLibrary(page)).toBe(knownGood);
  }

  await fileInput.setInputFiles({
    name: "second.json",
    mimeType: "application/json",
    buffer: Buffer.from(secondCanonical, "utf8"),
  });
  await expect(page.locator("[data-library-entry]")).toHaveCount(2);

  await page.locator('[data-library-action="delete"]').first().click();
  await expect(page.locator("[data-library-entry]")).toHaveCount(1);
  expect((await parsedLibrary(page)).items).toHaveLength(1);

  const clear = page.locator('[data-library-action="clear"]');
  await clear.click();
  await expect(clear).toHaveAttribute("aria-pressed", "true");
  await expect(clear).toHaveText("确认清空");
  await expect(page.locator("[data-library-entry]")).toHaveCount(1);

  await clear.click();
  await expect(page.locator("[data-library-entry]")).toHaveCount(0);
  await expect(page.locator(".workflow-recipe-library__count")).toHaveText(
    `0/${MAX_WORKFLOW_RECIPE_LIBRARY_ENTRIES}`,
  );
  expect(await serializedLibrary(page)).toBeNull();
});

for (const failureMode of ["unavailable", "quota"] as const) {
  test(`浏览器存储 ${failureMode} 时明确切到当前标签页内存模式`, async ({
    page,
  }) => {
    await page.addInitScript(
      ({ key, mode }) => {
        if (mode === "unavailable") {
          try {
            Object.defineProperty(globalThis, "localStorage", {
              configurable: true,
              get() {
                throw new DOMException("Storage unavailable", "SecurityError");
              },
            });
            return;
          } catch {
            // Fall through to a deterministic read failure for this key.
          }
        }

        const method = mode === "quota" ? "setItem" : "getItem";
        const nativeMethod = Storage.prototype[method];
        Object.defineProperty(Storage.prototype, method, {
          configurable: true,
          value(this: Storage, candidateKey: string, ...rest: string[]) {
            if (candidateKey === key) {
              throw new DOMException(
                mode === "quota" ? "Quota exceeded" : "Storage unavailable",
                mode === "quota" ? "QuotaExceededError" : "SecurityError",
              );
            }
            return Reflect.apply(nativeMethod, this, [candidateKey, ...rest]);
          },
        });
      },
      { key: WORKFLOW_RECIPE_LIBRARY_STORAGE_KEY, mode: failureMode },
    );

    await openBlankStudio(page);
    await buildTwoStepCustomRecipe(page);
    await saveCurrentRecipe(page);
    await expect(
      page.locator(".workflow-recipe-library__memory"),
    ).toContainText("当前为内存模式");
    await expect(
      page.locator("[data-library-feedback='warning']"),
    ).toContainText("当前标签页内存");
    await expect(page.locator("[data-library-entry]")).toHaveCount(1);

    await page.reload({ waitUntil: "networkidle" });
    await expect(page.locator("[data-library-entry]")).toHaveCount(0);
  });
}

test("同源标签页通过 StorageEvent 同步新增与删除，不同步任何正文", async ({
  context,
  page,
}) => {
  await openBlankStudio(page);
  const peer = await context.newPage();
  await openBlankStudio(peer);
  await openLibrary(page);
  await openLibrary(peer);

  await buildTwoStepCustomRecipe(page);
  await page.locator('[data-action="save-library-recipe"]').click();
  await expect(page.locator("[data-library-entry]")).toHaveCount(1);
  await expect(peer.locator("[data-library-entry]")).toHaveCount(1);

  const canary = "CROSS_TAB_PRIVATE_BODY_92e8";
  const input = Buffer.from(JSON.stringify({ canary }), "utf8").toString(
    "base64",
  );
  await page.locator("[data-workflow-input]").fill(input);
  expect(await browserPrivateState(peer)).not.toContain(canary);
  expect(await browserPrivateState(peer)).not.toContain(input);

  await page.locator('[data-library-action="delete"]').click();
  await expect(page.locator("[data-library-entry]")).toHaveCount(0);
  await expect(peer.locator("[data-library-entry]")).toHaveCount(0);
});

test("360px 配方库无横向溢出、触控目标达 44px，并可由键盘与辅助技术使用", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await openBlankStudio(page);
  await buildTwoStepCustomRecipe(page, true);
  await saveCurrentRecipe(page, true);

  const layout = await page.evaluate(() => {
    const library = document.querySelector<HTMLElement>(
      "[data-workflow-recipe-library]",
    );
    if (library === null) throw new Error("Recipe library missing");
    const interactive = [
      ...library.querySelectorAll<HTMLElement>(
        "summary, button, .workflow-recipe-library__file-picker",
      ),
    ].filter((element) => element.getClientRects().length > 0);
    return {
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      smallTargets: interactive
        .map((element) => {
          const rect = element.getBoundingClientRect();
          return {
            label: element.textContent?.trim() ?? element.tagName,
            width: rect.width,
            height: rect.height,
          };
        })
        .filter(({ width, height }) => width < 43.5 || height < 43.5),
    };
  });
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth + 1);
  expect(layout.smallTargets).toEqual([]);

  const axeResult = await new AxeBuilder({ page })
    .include("[data-workflow-recipe-library]")
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  const blockers = axeResult.violations.filter(
    (violation) =>
      violation.impact === "serious" || violation.impact === "critical",
  );
  if (blockers.length > 0) {
    await testInfo.attach("recipe-library-axe-blockers", {
      body: JSON.stringify(blockers, null, 2),
      contentType: "application/json",
    });
  }
  expect(blockers).toEqual([]);

  const load = page.locator('[data-library-action="load"]');
  await load.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("[data-workflow-step]")).toHaveCount(2);
});

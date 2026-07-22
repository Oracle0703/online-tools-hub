import { expect, test, type Page } from "@playwright/test";

type RegexWorkerLifecycle = {
  created: number;
  terminated: number;
  urls: string[];
};

type RegexWindow = Window &
  typeof globalThis & {
    readonly __regexWorkerLifecycle?: RegexWorkerLifecycle;
  };

const regexWorkerAssetPattern =
  /\/regex-tester\.worker[-.][A-Za-z0-9_-]+\.js$/u;

// Keep deterministic Worker interception separate from PWA routing. Offline
// execution through the Service Worker is covered in pwa.spec.ts.
test.use({ serviceWorkers: "block" });

async function installRegexWorkerLifecycleProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const NativeWorker = globalThis.Worker;
    const nativeTerminate = NativeWorker.prototype.terminate;
    const regexWorkers = new WeakSet<Worker>();
    const lifecycle: RegexWorkerLifecycle = {
      created: 0,
      terminated: 0,
      urls: [],
    };

    Object.defineProperty(NativeWorker.prototype, "terminate", {
      configurable: true,
      writable: true,
      value(this: Worker) {
        if (regexWorkers.has(this)) lifecycle.terminated += 1;
        return nativeTerminate.call(this);
      },
    });
    Object.defineProperty(globalThis, "Worker", {
      configurable: true,
      writable: true,
      value: new Proxy(NativeWorker, {
        construct(target, argumentsList) {
          const worker = Reflect.construct(
            target,
            argumentsList,
            target,
          ) as Worker;
          const url = String(argumentsList[0]);
          if (/\/regex-tester\.worker[-.][A-Za-z0-9_-]+\.js$/u.test(url)) {
            regexWorkers.add(worker);
            lifecycle.created += 1;
            lifecycle.urls.push(url);
          }
          return worker;
        },
      }),
    });
    Object.defineProperty(globalThis, "__regexWorkerLifecycle", {
      configurable: false,
      value: lifecycle,
    });
  });
}

async function regexWorkerLifecycle(page: Page): Promise<RegexWorkerLifecycle> {
  return page.evaluate(() => {
    const lifecycle = (window as RegexWindow).__regexWorkerLifecycle;
    if (lifecycle === undefined)
      throw new Error("Regex Worker probe is missing.");
    return {
      created: lifecycle.created,
      terminated: lifecycle.terminated,
      urls: [...lifecycle.urls],
    };
  });
}

async function openRegexTester(page: Page): Promise<void> {
  await page.goto("./tools/regex-tester/", {
    waitUntil: "domcontentloaded",
  });
  const workspace = page.locator('[data-tool-workspace="regex-tester"]');
  await expect(workspace).toBeVisible();

  const island = workspace.locator("xpath=ancestor::astro-island[1]");
  await expect(island).toHaveAttribute("client", "load");
  await expect.poll(() => island.getAttribute("ssr")).toBeNull();
}

async function runRegex(
  page: Page,
  pattern: string,
  subject: string,
): Promise<void> {
  await page.getByLabel("Pattern", { exact: true }).fill(pattern);
  await page.getByLabel("测试文本", { exact: true }).fill(subject);
  await page.getByRole("button", { name: "运行正则测试" }).click();
}

test("真实专用 Worker 返回 flags、Unicode 零宽匹配与捕获组", async ({
  page,
}) => {
  await installRegexWorkerLifecycleProbe(page);
  await openRegexTester(page);

  await runRegex(
    page,
    String.raw`(?<word>\p{L}+)(?:-(\d+))?`,
    "alpha-12 中文 beta",
  );
  const status = page.locator("[data-regex-status]");
  await expect(status).toHaveAttribute("data-regex-status", "success", {
    timeout: 10_000,
  });
  await expect(status).toContainText("共找到 3 项匹配");
  await expect(page.locator(".regex-tool__result-head")).toContainText(
    "flags /gu",
  );

  const matches = page.locator(".regex-tool__matches > li");
  await expect(matches).toHaveCount(3);
  await expect(matches.first()).toContainText("alpha-12");
  await expect(matches.first()).toContainText("$1");
  await expect(matches.first()).toContainText("$2");
  await expect(matches.first()).toContainText("word");

  await expect
    .poll(() => regexWorkerLifecycle(page))
    .toMatchObject({ created: 1, terminated: 1 });
  expect((await regexWorkerLifecycle(page)).urls).toEqual([
    expect.stringMatching(regexWorkerAssetPattern),
  ]);

  await runRegex(page, "(?:)", "😀");
  await expect(status).toHaveAttribute("data-regex-status", "success", {
    timeout: 10_000,
  });
  await expect(matches).toHaveCount(2);
  await expect(matches.nth(0)).toContainText("UTF-16 索引 [0, 0)");
  await expect(matches.nth(1)).toContainText("UTF-16 索引 [2, 2)");

  await page.getByRole("checkbox", { name: "Unicode u" }).uncheck();
  await page.getByRole("button", { name: "运行正则测试" }).click();
  await expect(status).toHaveAttribute("data-regex-status", "success", {
    timeout: 10_000,
  });
  await expect(matches).toHaveCount(2);
  await expect(matches.nth(0)).toContainText("UTF-16 索引 [0, 0)");
  await expect(matches.nth(1)).toContainText("UTF-16 索引 [2, 2)");
  await expect
    .poll(() => regexWorkerLifecycle(page))
    .toMatchObject({ created: 3, terminated: 3 });
});

test("大量匹配与捕获按页有界渲染，不把 Worker 结果变成主线程 DOM 风暴", async ({
  page,
}) => {
  await openRegexTester(page);

  await runRegex(page, "()".repeat(256), "a".repeat(1_000));
  const status = page.locator("[data-regex-status]");
  await expect(status).toContainText("达到匹配数量上限", { timeout: 10_000 });

  const visibleMatches = page.locator(".regex-tool__matches > li");
  await expect(visibleMatches).toHaveCount(50);
  await expect(visibleMatches.first()).toContainText("匹配 1");
  await expect(
    visibleMatches.first().locator(".regex-tool__captures > div"),
  ).toHaveCount(16);
  await expect(visibleMatches.first()).toContainText(
    "另有 240 个编号捕获未展开",
  );
  await expect(page.getByText("第 1 / 20 页")).toBeVisible();

  await page.getByRole("button", { name: "下一页" }).click();
  await expect(visibleMatches).toHaveCount(50);
  await expect(visibleMatches.first()).toContainText("匹配 51");
  await expect(page.getByText("第 2 / 20 页")).toBeVisible();
});

test("语法错误使用稳定文案，不把 pattern 或原生错误写入日志", async ({
  page,
}) => {
  const canary = "REGEX_PRIVATE_CANARY_7d91_中文";
  const consoleEntries: string[] = [];
  page.on("console", (message) => consoleEntries.push(message.text()));
  page.on("pageerror", (error) => consoleEntries.push(error.message));
  await openRegexTester(page);

  await runRegex(page, `(?<${canary}`, "private subject");
  const alert = page.getByRole("alert");
  await expect(alert).toContainText(
    "正则表达式语法无效，请检查括号、字符类与转义。",
    { timeout: 10_000 },
  );
  await expect(alert).not.toContainText(canary);
  expect(consoleEntries.join("\n")).not.toContain(canary);
});

test("取消会同步 terminate 不响应的真实 Worker", async ({ page }) => {
  let interceptedWorkers = 0;
  await page.route(regexWorkerAssetPattern, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/javascript; charset=utf-8",
      headers: { "cache-control": "no-store" },
      body: "while (true) {}",
    });
    interceptedWorkers += 1;
  });
  await installRegexWorkerLifecycleProbe(page);
  await openRegexTester(page);

  await runRegex(page, ".+", "cancel this isolated worker");
  const cancel = page.getByRole("button", { name: "取消并终止 Worker" });
  await expect(cancel).toBeVisible();
  await expect.poll(() => interceptedWorkers).toBe(1);
  const beforeCancel = await regexWorkerLifecycle(page);
  await cancel.click();
  await expect
    .poll(() => regexWorkerLifecycle(page))
    .toMatchObject({
      created: beforeCancel.created,
      terminated: beforeCancel.terminated + 1,
    });
  await expect(page.locator("[data-regex-status]")).toContainText(
    "正则测试已取消",
  );
  expect(interceptedWorkers).toBe(1);
});

test("2 秒截止时间会硬终止不响应的真实 Worker", async ({ page }) => {
  let interceptedWorkers = 0;
  await page.route(regexWorkerAssetPattern, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/javascript; charset=utf-8",
      headers: { "cache-control": "no-store" },
      body: "while (true) {}",
    });
    interceptedWorkers += 1;
  });
  await installRegexWorkerLifecycleProbe(page);
  await openRegexTester(page);

  const startedAt = Date.now();
  await runRegex(page, ".+", "timeout this isolated worker");
  const status = page.locator("[data-regex-status]");
  await expect(status).toContainText("正则执行超过 2 秒", {
    timeout: 8_000,
  });
  const elapsedMs = Date.now() - startedAt;
  expect(elapsedMs).toBeGreaterThanOrEqual(1_500);
  expect(elapsedMs).toBeLessThan(4_500);
  await expect
    .poll(() => regexWorkerLifecycle(page))
    .toMatchObject({ created: 1, terminated: 1 });
  expect(interceptedWorkers).toBe(1);
});

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { Browser, Builder, By, until } from "selenium-webdriver";

const requestedBrowser = process.argv[2];
const supportedBrowsers = new Set(["edge", "safari"]);

if (!supportedBrowsers.has(requestedBrowser)) {
  throw new Error("Usage: node scripts/real-browser-smoke.mjs <edge|safari>");
}

const host = "127.0.0.1";
const port = 4321;
const baseUrl = `http://${host}:${port}/online-tools-hub`;
const astroCli = fileURLToPath(
  new URL("../node_modules/astro/bin/astro.mjs", import.meta.url),
);
const qrUnsafeFixturePath = fileURLToPath(
  new URL("../tests/fixtures/qr-code/unsafe-url.png", import.meta.url),
);
const qrRotatedFixturePath = fileURLToPath(
  new URL("../tests/fixtures/qr-code/rotated.jpg", import.meta.url),
);
const qrInvertedFixturePath = fileURLToPath(
  new URL("../tests/fixtures/qr-code/inverted.webp", import.meta.url),
);
const qrUnsafeFixtureText =
  "javascript:alert(1)\nhttps://canary.invalid/qr?secret=local-only";
const qrUnicodeFixtureText = "二维码识别 fixture · Unicode 👋";
const routes = [
  ["处理数据，不交出数据。", "/"],
  ["JSON 格式化与校验", "/tools/json-formatter/"],
  ["Base64 编码与解码", "/tools/base64-codec/"],
  ["URL 编码与解码", "/tools/url-codec/"],
  ["Unix 时间戳转换", "/tools/unix-timestamp/"],
  ["UUID v4 生成器", "/tools/uuid-generator/"],
  ["图片压缩与格式转换", "/tools/image-compressor/"],
  ["二维码生成与识别", "/tools/qr-code/"],
  ["文本差异对比", "/tools/text-diff/"],
  ["正则表达式测试器", "/tools/regex-tester/"],
  ["SHA 哈希生成与校验", "/tools/hash-generator/"],
  ["YAML 与 JSON 互转", "/tools/yaml-json-converter/"],
  ["JWT 解码与声明检查", "/tools/jwt-decoder/"],
  ["CSV 与 JSON 互转", "/tools/csv-json-converter/"],
  ["URL 查询参数解析与构建", "/tools/query-params/"],
  ["把重复的复制与切换，变成一条可检查的本地步骤链", "/workflows/"],
  ["从空白创建你的本地工作流", "/workflows/new/"],
  ["解开 Base64 JSON", "/workflows/base64-json-inspect/"],
  ["YAML 配置转 Base64URL", "/workflows/yaml-config-to-base64url/"],
  ["CSV 测试夹具与 SHA-256", "/workflows/csv-api-fixture-sha256/"],
  ["回调地址参数审计", "/workflows/encoded-callback-query-audit/"],
  ["URL 编码 JWT 声明报告", "/workflows/encoded-jwt-claims/"],
  ["PNG 调色板编码与 SHA-256", "/workflows/png-palette-sha256/"],
  ["工具解决眼前问题，指南讲清背后的边界", "/guides/"],
  ["隐私边界，公开可验证", "/privacy/"],
  ["每一次变化，都说清楚", "/changelog/"],
];

const server = spawn(
  process.execPath,
  [astroCli, "preview", "--host", host, "--port", String(port)],
  {
    env: { ...process.env, ASTRO_TELEMETRY_DISABLED: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  },
);

let serverLog = "";
server.stdout.on("data", (chunk) => {
  serverLog += chunk.toString();
});
server.stderr.on("data", (chunk) => {
  serverLog += chunk.toString();
});

async function waitForServer() {
  const deadline = Date.now() + 60_000;

  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`Preview exited before it was ready.\n${serverLog}`);
    }

    try {
      const response = await fetch(`${baseUrl}/`);
      if (response.ok) return;
    } catch {
      // The preview process is still starting.
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Preview did not become ready.\n${serverLog}`);
}

async function dismissTransientPwaNotice() {
  const dismissed = await driver.executeScript(() => {
    const notice = document.querySelector("[data-pwa-notice]");
    const buttons = notice?.querySelectorAll("button");
    const dismissButton = buttons?.item((buttons?.length ?? 0) - 1);

    if (!(dismissButton instanceof HTMLButtonElement)) return false;
    dismissButton.click();
    return true;
  });

  if (dismissed) {
    await driver.wait(
      async () =>
        (await driver.findElements(By.css("[data-pwa-notice]"))).length === 0,
      5_000,
    );
  }
}

let driver;
let failure;
const startedAt = new Date();
const evidence = {
  commit: process.env.GITHUB_SHA ?? "local",
  runId: process.env.GITHUB_RUN_ID ?? "local",
  runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? "local",
  browser: requestedBrowser,
  browserVersion: "pending",
  platform: process.platform,
  platformName: process.platform,
  startedAt: startedAt.toISOString(),
  completedAt: "pending",
  durationMs: 0,
  error: null,
  quitError: null,
  routes: [],
  assertions: {},
};

try {
  await waitForServer();
  driver = await new Builder()
    .forBrowser(requestedBrowser === "edge" ? Browser.EDGE : Browser.SAFARI)
    .build();
  const capabilities = await driver.getCapabilities();
  evidence.browserVersion = capabilities.get("browserVersion") ?? "unknown";
  evidence.platformName = capabilities.get("platformName") ?? process.platform;

  for (const [expectedHeading, path] of routes) {
    await driver.get(`${baseUrl}${path}`);
    const heading = await driver.wait(
      until.elementLocated(By.css("h1")),
      15_000,
    );
    await driver.wait(until.elementIsVisible(heading), 15_000);
    const actualHeading = await heading.getText();

    const normalizedHeading = actualHeading.replace(/\s+/gu, "");
    const normalizedExpectedHeading = expectedHeading.replace(/\s+/gu, "");

    if (!normalizedHeading.includes(normalizedExpectedHeading)) {
      throw new Error(
        `${path} heading mismatch: expected ${expectedHeading}, received ${actualHeading}`,
      );
    }

    evidence.routes.push({
      path,
      heading: actualHeading,
      title: await driver.getTitle(),
      url: await driver.getCurrentUrl(),
    });
  }

  await driver.get(`${baseUrl}/tools/json-formatter/`);
  const inputLabel = await driver.findElement(
    By.xpath('//label[normalize-space()="输入"]'),
  );
  const input = await driver.findElement(
    By.id(await inputLabel.getAttribute("for")),
  );
  await input.sendKeys('{"release":"candidate","safe":true}');
  await driver
    .findElement(By.xpath('//button[normalize-space()="格式化"]'))
    .click();
  const outputLabel = await driver.findElement(
    By.xpath('//label[normalize-space()="输出"]'),
  );
  const output = await driver.findElement(
    By.id(await outputLabel.getAttribute("for")),
  );
  await driver.wait(
    async () => (await output.getAttribute("value")).includes("candidate"),
    10_000,
  );
  evidence.assertions.jsonInteraction = true;

  await driver.get(`${baseUrl}/tools/regex-tester/`);
  const regexPatternLabel = await driver.findElement(
    By.xpath('//label[normalize-space()="Pattern"]'),
  );
  const regexPattern = await driver.findElement(
    By.id(await regexPatternLabel.getAttribute("for")),
  );
  await regexPattern.clear();
  await regexPattern.sendKeys("([A-Z]+)-(\\d+)");
  const regexSubjectLabel = await driver.findElement(
    By.xpath('//label[normalize-space()="测试文本"]'),
  );
  const regexSubject = await driver.findElement(
    By.id(await regexSubjectLabel.getAttribute("for")),
  );
  await regexSubject.clear();
  await regexSubject.sendKeys("ORDER-42");
  await driver
    .findElement(By.xpath('//button[normalize-space()="运行正则测试"]'))
    .click();
  const regexStatus = await driver.findElement(By.css("[data-regex-status]"));
  await driver.wait(
    async () => (await regexStatus.getText()).includes("测试完成"),
    10_000,
  );
  const regexMatches = await driver.findElement(By.css(".regex-tool__matches"));
  await driver.wait(
    async () => (await regexMatches.getText()).includes("ORDER-42"),
    10_000,
  );
  evidence.assertions.regexInteraction = true;

  await driver.get(`${baseUrl}/tools/qr-code/`);
  await driver
    .findElement(By.css('input[name="qr-mode"][value="scan"]'))
    .click();
  const qrInput = await driver.findElement(By.css(".qr-tool__file-input"));
  const qrStatus = await driver.findElement(By.css("[data-qr-status]"));
  const qrInitialUrl = await driver.getCurrentUrl();

  const scanQrFixture = async (fixturePath, expectedText) => {
    await qrInput.sendKeys(fixturePath);
    await driver.wait(
      async () => (await qrStatus.getText()).includes("图片头部已验证"),
      10_000,
    );
    await driver
      .findElement(By.xpath('//button[normalize-space()="识别二维码"]'))
      .click();
    const result = await driver.wait(
      until.elementLocated(By.css("[data-qr-scan-result]")),
      15_000,
    );
    await driver.wait(
      async () => (await result.getAttribute("value")) === expectedText,
      15_000,
    );
  };

  await scanQrFixture(qrRotatedFixturePath, qrUnicodeFixtureText);
  evidence.assertions.qrJpegInteraction = true;
  await scanQrFixture(qrInvertedFixturePath, qrUnicodeFixtureText);
  evidence.assertions.qrWebpInteraction = true;
  await scanQrFixture(qrUnsafeFixturePath, qrUnsafeFixtureText);
  evidence.assertions.qrInteraction = true;
  evidence.assertions.qrNoNavigation =
    (await driver.getCurrentUrl()) === qrInitialUrl &&
    (
      await driver.findElements(
        By.css('a[href*="canary.invalid"], a[href^="javascript:"]'),
      )
    ).length === 0;
  if (!evidence.assertions.qrNoNavigation) {
    throw new Error("QR text unexpectedly created navigation capability");
  }
  const externalQrResources = await driver.executeScript(() =>
    performance
      .getEntriesByType("resource")
      .map((entry) => new URL(entry.name, location.href))
      .filter(
        (url) =>
          (url.protocol === "http:" || url.protocol === "https:") &&
          url.origin !== location.origin,
      )
      .map((url) => url.href),
  );
  evidence.assertions.qrNoExternalRequests =
    Array.isArray(externalQrResources) && externalQrResources.length === 0;
  if (!evidence.assertions.qrNoExternalRequests) {
    throw new Error(
      `QR requested external resources: ${JSON.stringify(externalQrResources)}`,
    );
  }

  await driver.get(`${baseUrl}/workflows/base64-json-inspect/`);
  const workflowStudio = await driver.wait(
    until.elementLocated(By.css("[data-workflow-studio]")),
    15_000,
  );
  await driver.wait(until.elementIsVisible(workflowStudio), 15_000);
  const workflowInput = await driver.findElement(
    By.css("[data-workflow-input]"),
  );
  await workflowInput.sendKeys("eyJyZWxlYXNlIjoidjEuMCIsInNhZmUiOnRydWV9");
  const runWorkflow = await driver.findElement(By.css('[data-action="run"]'));
  await driver.wait(async () => runWorkflow.isEnabled(), 10_000);
  await dismissTransientPwaNotice();
  await driver.executeScript(
    'arguments[0].scrollIntoView({ block: "center", inline: "nearest" });',
    runWorkflow,
  );
  await runWorkflow.click();
  await driver.wait(
    async () =>
      (await workflowStudio.getAttribute("data-runtime-status")) ===
      "succeeded",
    20_000,
  );
  const finalPreview = await driver.findElement(
    By.css('[data-workflow-step]:last-child [data-preview-kind="text"] pre'),
  );
  await driver.wait(
    async () => (await finalPreview.getText()).includes('"release": "v1.0"'),
    10_000,
  );
  evidence.assertions.workflowInteraction = true;

  const externalWorkflowResources = await driver.executeScript(() =>
    performance
      .getEntriesByType("resource")
      .map((entry) => new URL(entry.name, location.href))
      .filter(
        (url) =>
          (url.protocol === "http:" || url.protocol === "https:") &&
          url.origin !== location.origin,
      )
      .map((url) => url.href),
  );
  if (
    !Array.isArray(externalWorkflowResources) ||
    externalWorkflowResources.length > 0
  ) {
    throw new Error(
      `Workflow requested external resources: ${JSON.stringify(externalWorkflowResources)}`,
    );
  }
  evidence.assertions.workflowNoExternalRequests = true;

  await driver.findElement(By.css('[data-action="clear"]')).click();
  await driver.wait(
    async () =>
      (await workflowInput.getAttribute("value")) === "" &&
      (await workflowStudio.getAttribute("data-runtime-status")) === "idle",
    10_000,
  );
  evidence.assertions.workflowClear = true;

  await driver.manage().window().setRect({ width: 360, height: 800 });
  const workflowViewport = await driver.executeScript(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  if (workflowViewport.scrollWidth > workflowViewport.clientWidth + 1) {
    throw new Error(
      `360px workflow viewport overflow: ${JSON.stringify(workflowViewport)}`,
    );
  }
  evidence.assertions.workflowMobile360NoOverflow = true;

  await mkdir("release-evidence", { recursive: true });
  await writeFile(
    `release-evidence/${requestedBrowser}-mobile.png`,
    await driver.takeScreenshot(),
    "base64",
  );

  await driver.get(`${baseUrl}/tools/image-compressor/`);
  const viewport = await driver.executeScript(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));

  if (viewport.scrollWidth > viewport.clientWidth + 1) {
    throw new Error(`360px viewport overflow: ${JSON.stringify(viewport)}`);
  }
  evidence.assertions.mobile360NoOverflow = true;
  evidence.assertions.localPrivacyBadge =
    (await driver.findElements(By.css('[data-privacy-mode="local"]'))).length >
    0;

  if (!evidence.assertions.localPrivacyBadge) {
    throw new Error("Local privacy badge was not found");
  }

  await driver.get(`${baseUrl}/privacy/`);
  const privacyCenter = await driver.wait(
    until.elementLocated(By.css("[data-privacy-self-test]")),
    15_000,
  );
  const offlineTrigger = await driver.wait(
    until.elementLocated(By.css("[data-pwa-offline-trigger]")),
    15_000,
  );
  evidence.assertions.privacyCenter =
    (await privacyCenter.isDisplayed()) && (await offlineTrigger.isDisplayed());
  if (!evidence.assertions.privacyCenter) {
    throw new Error("Privacy capability center or offline trigger was hidden");
  }
} catch (error) {
  failure = error;
  evidence.error = error instanceof Error ? error.stack : String(error);
} finally {
  if (driver) {
    try {
      await driver.quit();
    } catch (error) {
      evidence.quitError =
        error instanceof Error ? error.message : String(error);
    }
  }
  server.kill();
}

evidence.completedAt = new Date().toISOString();
evidence.durationMs = Date.now() - startedAt.getTime();
await mkdir("release-evidence", { recursive: true });
await writeFile(
  `release-evidence/${requestedBrowser}.json`,
  `${JSON.stringify(evidence, null, 2)}\n`,
);

if (failure) throw failure;

console.log(
  `Real ${requestedBrowser} smoke passed: ${routes.length} routes, JSON + regex + QR + workflow interactions, privacy center and 360px layouts.`,
);

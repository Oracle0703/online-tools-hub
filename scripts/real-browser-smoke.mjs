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
const routes = [
  ["处理数据，不交出数据。", "/"],
  ["JSON 格式化与校验", "/tools/json-formatter/"],
  ["Base64 编码与解码", "/tools/base64-codec/"],
  ["URL 编码与解码", "/tools/url-codec/"],
  ["Unix 时间戳转换", "/tools/unix-timestamp/"],
  ["UUID v4 生成器", "/tools/uuid-generator/"],
  ["图片压缩与格式转换", "/tools/image-compressor/"],
  ["文本差异对比", "/tools/text-diff/"],
  ["SHA 哈希生成与校验", "/tools/hash-generator/"],
  ["YAML 与 JSON 互转", "/tools/yaml-json-converter/"],
  ["JWT 解码与声明检查", "/tools/jwt-decoder/"],
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

let driver;
let failure;
const startedAt = new Date();
const evidence = {
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

  await driver.manage().window().setRect({ width: 360, height: 800 });
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

  await mkdir("release-evidence", { recursive: true });
  await writeFile(
    `release-evidence/${requestedBrowser}-mobile.png`,
    await driver.takeScreenshot(),
    "base64",
  );
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
  `Real ${requestedBrowser} smoke passed: ${routes.length} routes, JSON interaction and 360px layout.`,
);

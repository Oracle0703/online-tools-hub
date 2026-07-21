import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const evidenceDirectory =
  process.env.RELEASE_EVIDENCE_DIR === undefined
    ? fileURLToPath(new URL("../release-evidence/", import.meta.url))
    : path.resolve(process.env.RELEASE_EVIDENCE_DIR);

const requiredRoutes = Object.freeze([
  "/",
  "/workflows/",
  "/workflows/base64-json-inspect/",
  "/privacy/",
]);

const requiredAssertions = Object.freeze([
  "jsonInteraction",
  "workflowInteraction",
  "workflowClear",
  "workflowNoExternalRequests",
  "privacyCenter",
  "mobile360NoOverflow",
  "workflowMobile360NoOverflow",
  "localPrivacyBadge",
]);

const browserRequirements = Object.freeze([
  { id: "edge", platform: "win32" },
  { id: "safari", platform: "darwin" },
]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function isIsoTimestamp(value) {
  return (
    typeof value === "string" &&
    value !== "pending" &&
    Number.isFinite(Date.parse(value))
  );
}

async function readEvidence(browser) {
  const source = await readFile(
    path.join(evidenceDirectory, `${browser}.json`),
    "utf8",
  );
  const evidence = JSON.parse(source);

  assert(
    evidence !== null &&
      typeof evidence === "object" &&
      !Array.isArray(evidence),
    `${browser}.json 必须是对象`,
  );
  return evidence;
}

const records = [];
for (const requirement of browserRequirements) {
  const evidence = await readEvidence(requirement.id);
  assert(
    evidence.browser === requirement.id,
    `${requirement.id}.json 的浏览器标识不匹配`,
  );
  assert(
    evidence.platform === requirement.platform,
    `${requirement.id}.json 必须来自 ${requirement.platform}`,
  );
  assert(
    typeof evidence.browserVersion === "string" &&
      evidence.browserVersion !== "" &&
      evidence.browserVersion !== "pending",
    `${requirement.id}.json 缺少真实浏览器版本`,
  );
  assert(
    isIsoTimestamp(evidence.startedAt) &&
      isIsoTimestamp(evidence.completedAt) &&
      Date.parse(evidence.completedAt) >= Date.parse(evidence.startedAt),
    `${requirement.id}.json 的执行时间无效`,
  );
  assert(
    Number.isSafeInteger(evidence.durationMs) && evidence.durationMs >= 0,
    `${requirement.id}.json 的执行耗时无效`,
  );
  assert(
    evidence.error === null && evidence.quitError === null,
    `${requirement.id}.json 包含浏览器执行或退出错误`,
  );

  const expectedCommit = process.env.GITHUB_SHA ?? evidence.commit;
  assert(
    typeof evidence.commit === "string" && evidence.commit !== "",
    `${requirement.id}.json 缺少 commit SHA`,
  );
  assert(
    evidence.commit === expectedCommit,
    `${requirement.id}.json 的 commit 与候选提交不一致`,
  );

  assert(Array.isArray(evidence.routes), `${requirement.id}.json 缺少路由记录`);
  const routePaths = new Set(evidence.routes.map((route) => route?.path));
  for (const route of requiredRoutes) {
    assert(
      routePaths.has(route),
      `${requirement.id}.json 缺少真实浏览器路由 ${route}`,
    );
  }
  assert(
    routePaths.size === evidence.routes.length,
    `${requirement.id}.json 包含重复路由`,
  );

  assert(
    evidence.assertions !== null &&
      typeof evidence.assertions === "object" &&
      !Array.isArray(evidence.assertions),
    `${requirement.id}.json 缺少断言记录`,
  );
  for (const assertion of requiredAssertions) {
    assert(
      evidence.assertions[assertion] === true,
      `${requirement.id}.json 的 ${assertion} 未通过`,
    );
  }

  records.push(evidence);
}

const [firstRecord] = records;
assert(firstRecord !== undefined, "没有真实浏览器证据");
assert(
  records.every((record) => record.commit === firstRecord.commit),
  "Edge 与 Safari 证据不属于同一候选提交",
);

const summary = {
  format: "online-tools-hub/v1-release-evidence",
  version: 1,
  commit: firstRecord.commit,
  runId: process.env.GITHUB_RUN_ID ?? firstRecord.runId ?? "local",
  runAttempt:
    process.env.GITHUB_RUN_ATTEMPT ?? firstRecord.runAttempt ?? "local",
  verifiedAt: new Date().toISOString(),
  browsers: records.map((record) => ({
    browser: record.browser,
    browserVersion: record.browserVersion,
    platform: record.platform,
    platformName: record.platformName,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    durationMs: record.durationMs,
    routeCount: record.routes.length,
    assertions: Object.fromEntries(
      requiredAssertions.map((assertion) => [assertion, true]),
    ),
  })),
};

await mkdir(evidenceDirectory, { recursive: true });
await writeFile(
  path.join(evidenceDirectory, "summary.json"),
  `${JSON.stringify(summary, null, 2)}\n`,
);

console.log(
  `Verified v1.0 release evidence for ${records.map((record) => record.browser).join(" + ")} at ${firstRecord.commit}.`,
);

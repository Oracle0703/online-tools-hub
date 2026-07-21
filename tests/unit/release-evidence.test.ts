import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];
const commit = "1234567890abcdef1234567890abcdef12345678";

const assertions = {
  jsonInteraction: true,
  workflowInteraction: true,
  workflowClear: true,
  workflowNoExternalRequests: true,
  privacyCenter: true,
  mobile360NoOverflow: true,
  workflowMobile360NoOverflow: true,
  localPrivacyBadge: true,
};

function record(browser: "edge" | "safari", platform: "win32" | "darwin") {
  return {
    commit,
    runId: "42",
    runAttempt: "1",
    browser,
    browserVersion: "1.0",
    platform,
    platformName: platform,
    startedAt: "2026-07-21T00:00:00.000Z",
    completedAt: "2026-07-21T00:00:01.000Z",
    durationMs: 1_000,
    error: null,
    quitError: null,
    routes: [
      { path: "/", title: "Home" },
      { path: "/workflows/", title: "Workflows" },
      {
        path: "/workflows/base64-json-inspect/",
        title: "Workflow",
      },
      { path: "/privacy/", title: "Privacy" },
    ],
    assertions,
  };
}

async function fixtureDirectory(): Promise<string> {
  const directory = await mkdtemp(
    path.join(tmpdir(), "online-tools-release-evidence-"),
  );
  temporaryDirectories.push(directory);
  await Promise.all([
    writeFile(
      path.join(directory, "edge.json"),
      JSON.stringify(record("edge", "win32")),
    ),
    writeFile(
      path.join(directory, "safari.json"),
      JSON.stringify(record("safari", "darwin")),
    ),
  ]);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("v1 real-browser evidence verifier", () => {
  it("aggregates matching Edge and Safari records for the candidate commit", async () => {
    const directory = await fixtureDirectory();
    const { stdout } = await execFileAsync(
      process.execPath,
      ["scripts/verify-release-evidence.mjs"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          GITHUB_SHA: commit,
          GITHUB_RUN_ID: "42",
          GITHUB_RUN_ATTEMPT: "1",
          RELEASE_EVIDENCE_DIR: directory,
        },
      },
    );

    const summary = JSON.parse(
      await readFile(path.join(directory, "summary.json"), "utf8"),
    ) as {
      format: string;
      commit: string;
      browsers: Array<{ browser: string; routeCount: number }>;
    };
    expect(stdout).toContain(`at ${commit}`);
    expect(summary).toMatchObject({
      format: "online-tools-hub/v1-release-evidence",
      commit,
      browsers: [
        { browser: "edge", routeCount: 4 },
        { browser: "safari", routeCount: 4 },
      ],
    });
  });

  it("rejects a record that belongs to another commit", async () => {
    const directory = await fixtureDirectory();
    const safariPath = path.join(directory, "safari.json");
    const safari = JSON.parse(await readFile(safariPath, "utf8")) as {
      commit: string;
    };
    safari.commit = "ffffffffffffffffffffffffffffffffffffffff";
    await writeFile(safariPath, JSON.stringify(safari));

    await expect(
      execFileAsync(process.execPath, ["scripts/verify-release-evidence.mjs"], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          GITHUB_SHA: commit,
          RELEASE_EVIDENCE_DIR: directory,
        },
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("commit 与候选提交不一致"),
    });
  });
});

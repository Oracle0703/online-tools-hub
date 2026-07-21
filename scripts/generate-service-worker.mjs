import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { generateServiceWorker } from "./pwa-build-core.mjs";
import { assertPrivacyManifest } from "./privacy-manifest-core.mjs";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const distDirectory = path.join(projectRoot, "dist");
const basePath = process.env.PUBLIC_BASE_PATH ?? "/online-tools-hub/";

const privacyManifestPath = path.join(distDirectory, "privacy-manifest.json");
const privacyManifest = JSON.parse(await readFile(privacyManifestPath, "utf8"));
assertPrivacyManifest(privacyManifest);

const result = await generateServiceWorker({ distDirectory, basePath });
console.log(
  `Generated ${path.relative(projectRoot, result.destination)} (${result.version}) with ${result.shellUrls.length} shell URLs / ${result.shellBytes} B and ${result.urls.length} package URLs / ${result.totalBytes} B.`,
);

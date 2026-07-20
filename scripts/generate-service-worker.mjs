import path from "node:path";
import { fileURLToPath } from "node:url";

import { generateServiceWorker } from "./pwa-build-core.mjs";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const distDirectory = path.join(projectRoot, "dist");
const basePath = process.env.PUBLIC_BASE_PATH ?? "/online-tools-hub/";

const result = await generateServiceWorker({ distDirectory, basePath });
console.log(
  `Generated ${path.relative(projectRoot, result.destination)} (${result.version}) with ${result.urls.length} precached URLs.`,
);

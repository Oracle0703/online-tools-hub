import {
  PRIVACY_MANIFEST_FORMAT,
  PRIVACY_MANIFEST_REQUIRED_COVERS,
  PRIVACY_MANIFEST_REQUIRED_CSP_DIRECTIVES,
  PRIVACY_MANIFEST_REQUIRED_EXCLUDES,
  PRIVACY_MANIFEST_SELF_TEST_NON_ASSESSMENTS,
  PRIVACY_MANIFEST_SELF_TEST_OBSERVATIONS,
  PRIVACY_MANIFEST_SELF_TEST_TARGETS,
  PRIVACY_MANIFEST_VERSION,
  freezePrivacyManifest,
  type PrivacyManifestV1,
} from "../../scripts/privacy-manifest-core.mjs";
import { enabledTools } from "../lib/tool-catalog";
import { TOOL_MEMORY_STORAGE_KEY } from "../lib/tool-memory";
import { WORKFLOW_RECIPE_LIBRARY_STORAGE_KEY } from "../lib/workflow-recipe-library";
import { operationManifests } from "../operations/catalog";
import { workflowTemplates } from "../workflows/templates";

export const THEME_STORAGE_KEY = "online-tools-hub:theme" as const;

function createPrivacyManifest(): PrivacyManifestV1 {
  const tools = enabledTools.map((tool) => {
    if (tool.privacyMode !== "local" || tool.status !== "available") {
      throw new TypeError(
        `Privacy manifest v1 cannot publish non-local tool '${tool.id}'.`,
      );
    }
    return {
      id: tool.id,
      route: `tools/${tool.slug}/`,
      mode: "local" as const,
    };
  });
  tools.sort((left, right) => left.id.localeCompare(right.id, "en"));

  const operations = operationManifests.map((operation) => {
    if (
      operation.capabilities.network !== "forbidden" ||
      operation.capabilities.persistence !== "forbidden"
    ) {
      throw new TypeError(
        `Privacy manifest v1 cannot publish networked Operation '${operation.id}'.`,
      );
    }
    return {
      id: operation.id,
      toolId: operation.toolSlug,
      network: operation.capabilities.network,
      persistence: operation.capabilities.persistence,
      environment: [...operation.capabilities.environment].sort((left, right) =>
        left.localeCompare(right, "en"),
      ),
    };
  });
  operations.sort((left, right) => left.id.localeCompare(right.id, "en"));

  const workflows = workflowTemplates.map((workflow) => ({
    id: workflow.id,
    operationIds: workflow.recipe.steps.map((step) => step.operationId),
  }));
  workflows.sort((left, right) => left.id.localeCompare(right.id, "en"));

  return freezePrivacyManifest({
    format: PRIVACY_MANIFEST_FORMAT,
    version: PRIVACY_MANIFEST_VERSION,
    scope: {
      path: "./",
      covers: [...PRIVACY_MANIFEST_REQUIRED_COVERS],
      excludes: [...PRIVACY_MANIFEST_REQUIRED_EXCLUDES],
    },
    data: {
      processing: "browser-local",
      userContentNetwork: "forbidden",
      userContentPersistence: "forbidden",
      telemetry: "none",
      thirdPartyRuntime: "bundled-dependencies-no-remote-code",
    },
    network: {
      publicResources: {
        origin: "same-origin",
        methods: ["GET"],
        mayContainUserContent: false,
      },
    },
    interactions: {
      automaticClipboardRead: "forbidden",
      clipboardWrite: "user-gesture-only",
      downloads: "user-gesture-only",
      objectUrls: "temporary-and-revoked",
    },
    allowedState: [
      {
        id: "theme-preference",
        storage: "local-storage",
        key: THEME_STORAGE_KEY,
        mayContainUserContent: false,
      },
      {
        id: "tool-memory",
        storage: "local-storage",
        key: TOOL_MEMORY_STORAGE_KEY,
        fields: ["version", "favorites", "recent", "slug", "at"],
        mayContainUserContent: false,
      },
      {
        id: "workflow-recipe-library",
        storage: "local-storage",
        key: WORKFLOW_RECIPE_LIBRARY_STORAGE_KEY,
        fields: [
          "format",
          "version",
          "items",
          "id",
          "updatedAt",
          "recipe",
          "steps",
          "operationId",
          "options",
        ],
        mayContainUserContent: false,
      },
      {
        id: "public-static-build-assets",
        storage: "cache-storage",
        mayContainUserContent: false,
        constraints: {
          origin: "same-origin",
          method: "GET",
          query: "forbidden",
          source: "build-allowlist",
        },
      },
      {
        id: "service-worker-registration",
        storage: "service-worker-registration",
        scope: "site-base",
        script: "same-origin-build-artifact",
        mayContainUserContent: false,
      },
    ],
    enforcement: {
      csp: {
        requiredDirectives: [...PRIVACY_MANIFEST_REQUIRED_CSP_DIRECTIVES],
      },
      operationWorker: "fail-closed",
      toolWorkers: "fail-closed",
      sourceScan: "build-gate",
      registryCoverage: "build-gate",
    },
    inventory: { tools, operations, workflows },
    selfTest: {
      input: "generated-synthetic-only",
      acceptsUserContent: false,
      retention: "memory-only",
      targets: [...PRIVACY_MANIFEST_SELF_TEST_TARGETS],
      observations: [...PRIVACY_MANIFEST_SELF_TEST_OBSERVATIONS],
      conclusion: "current-site-current-run-only",
      doesNotAssess: [...PRIVACY_MANIFEST_SELF_TEST_NON_ASSESSMENTS],
    },
  });
}

export const privacyManifest = createPrivacyManifest();

export type { PrivacyManifestV1 } from "../../scripts/privacy-manifest-core.mjs";

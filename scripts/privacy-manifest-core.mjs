export const PRIVACY_MANIFEST_FORMAT = "online-tools-hub/privacy-manifest";
export const PRIVACY_MANIFEST_VERSION = 1;

export const PRIVACY_MANIFEST_REQUIRED_COVERS = Object.freeze([
  "site-code",
  "tool-runtime",
  "operation-runtime",
  "workflow-runtime",
  "service-worker",
]);

export const PRIVACY_MANIFEST_REQUIRED_EXCLUDES = Object.freeze([
  "browser-extensions",
  "browser-implementation",
  "operating-system",
  "network-infrastructure",
  "hosting-logs",
  "other-tabs-and-sites",
]);

export const PRIVACY_MANIFEST_REQUIRED_CSP_DIRECTIVES = Object.freeze([
  "default-src 'self'",
  "base-uri 'self'",
  "connect-src 'none'",
  "font-src 'self'",
  "form-action 'none'",
  "frame-src 'none'",
  "img-src 'self' data: blob:",
  "manifest-src 'self'",
  "media-src 'none'",
  "object-src 'none'",
  "worker-src 'self'",
]);

export const PRIVACY_MANIFEST_SELF_TEST_TARGETS = Object.freeze([
  "operation-worker",
  "built-in-workflow",
]);

export const PRIVACY_MANIFEST_SELF_TEST_OBSERVATIONS = Object.freeze([
  "csp",
  "security-policy-violations",
  "resource-urls",
  "location-and-history",
  "cookie-and-web-storage",
  "indexeddb-database-names",
  "cache-storage-requests-and-bodies",
  "runtime-resource-counters",
]);

export const PRIVACY_MANIFEST_SELF_TEST_NON_ASSESSMENTS = Object.freeze([
  ...PRIVACY_MANIFEST_REQUIRED_EXCLUDES,
  "indexeddb-record-values",
]);

const ROOT_KEYS = new Set([
  "format",
  "version",
  "scope",
  "data",
  "network",
  "interactions",
  "allowedState",
  "enforcement",
  "inventory",
  "selfTest",
]);
const SCOPE_KEYS = new Set(["path", "covers", "excludes"]);
const DATA_KEYS = new Set([
  "processing",
  "userContentNetwork",
  "userContentPersistence",
  "telemetry",
  "thirdPartyRuntime",
]);
const NETWORK_KEYS = new Set(["publicResources"]);
const PUBLIC_RESOURCE_KEYS = new Set([
  "origin",
  "methods",
  "mayContainUserContent",
]);
const INTERACTION_KEYS = new Set([
  "automaticClipboardRead",
  "clipboardWrite",
  "downloads",
  "objectUrls",
]);
const ALLOWED_STATE_KEYS = new Set([
  "id",
  "storage",
  "key",
  "fields",
  "mayContainUserContent",
  "constraints",
  "scope",
  "script",
]);
const CACHE_CONSTRAINT_KEYS = new Set(["origin", "method", "query", "source"]);
const SERVICE_WORKER_STATE_KEYS = new Set([
  "id",
  "storage",
  "scope",
  "script",
  "mayContainUserContent",
]);
const ENFORCEMENT_KEYS = new Set([
  "csp",
  "operationWorker",
  "toolWorkers",
  "sourceScan",
  "registryCoverage",
]);
const CSP_KEYS = new Set(["requiredDirectives"]);
const INVENTORY_KEYS = new Set(["tools", "operations", "workflows"]);
const TOOL_KEYS = new Set(["id", "route", "mode"]);
const OPERATION_KEYS = new Set([
  "id",
  "toolId",
  "network",
  "persistence",
  "environment",
]);
const WORKFLOW_KEYS = new Set(["id", "operationIds"]);
const SELF_TEST_KEYS = new Set([
  "input",
  "acceptsUserContent",
  "retention",
  "targets",
  "observations",
  "conclusion",
  "doesNotAssess",
]);

const ID_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u;
const FIELD_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,63}$/u;
const ROUTE_PATTERN = /^[a-z0-9]+(?:[./-][a-z0-9]+)*\/$/u;
const STORAGE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/u;

export class PrivacyManifestValidationError extends TypeError {
  constructor(issues) {
    super(`Invalid privacy manifest: ${issues.join("; ")}`);
    this.name = "PrivacyManifestValidationError";
    this.issues = Object.freeze([...issues]);
  }
}

function isPlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyEnumerableDataProperties(value, allowedKeys) {
  if (!isPlainRecord(value)) return false;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowedKeys.has(key)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) return false;
  }
  return true;
}

function hasExactKeys(value, expectedKeys) {
  return (
    hasOnlyEnumerableDataProperties(value, expectedKeys) &&
    Object.keys(value).length === expectedKeys.size
  );
}

function isIdentifier(value) {
  return typeof value === "string" && ID_PATTERN.test(value);
}

function isUniqueStringArray(value, options = {}) {
  const { allowEmpty = false, pattern } = options;
  return (
    Array.isArray(value) &&
    (allowEmpty || value.length > 0) &&
    value.every(
      (entry) =>
        typeof entry === "string" &&
        entry.length > 0 &&
        (pattern === undefined || pattern.test(entry)),
    ) &&
    new Set(value).size === value.length
  );
}

function sameOrderedValues(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function isSortedUniqueIdentifierList(values) {
  return (
    isUniqueStringArray(values, { allowEmpty: true, pattern: ID_PATTERN }) &&
    values.every(
      (value, index) =>
        index === 0 || values[index - 1].localeCompare(value, "en") < 0,
    )
  );
}

function recordsAreSortedById(values) {
  return values.every((value, index) => {
    if (!isPlainRecord(value) || typeof value.id !== "string") return false;
    if (index === 0) return true;
    const previous = values[index - 1];
    return (
      isPlainRecord(previous) &&
      typeof previous.id === "string" &&
      previous.id.localeCompare(value.id, "en") < 0
    );
  });
}

function validateAllowedState(value, index, issues) {
  const path = `allowedState[${index}]`;
  if (!hasOnlyEnumerableDataProperties(value, ALLOWED_STATE_KEYS)) {
    issues.push(`${path} must be a plain record with documented fields only`);
    return;
  }
  if (!isIdentifier(value.id)) issues.push(`${path}.id is invalid`);
  if (value.mayContainUserContent !== false) {
    issues.push(`${path}.mayContainUserContent must be false`);
  }

  if (value.storage === "local-storage") {
    const expectedKeys = new Set([
      "id",
      "storage",
      "key",
      "fields",
      "mayContainUserContent",
    ]);
    const expectedWithoutFields = new Set([
      "id",
      "storage",
      "key",
      "mayContainUserContent",
    ]);
    if (
      !hasExactKeys(value, expectedKeys) &&
      !hasExactKeys(value, expectedWithoutFields)
    ) {
      issues.push(`${path} has invalid local-storage fields`);
      return;
    }
    if (typeof value.key !== "string" || !STORAGE_KEY_PATTERN.test(value.key)) {
      issues.push(`${path}.key is invalid`);
    }
    if (
      value.fields !== undefined &&
      !isUniqueStringArray(value.fields, { pattern: FIELD_NAME_PATTERN })
    ) {
      issues.push(`${path}.fields must be a unique identifier list`);
    }
    return;
  }

  if (value.storage === "cache-storage") {
    const expectedKeys = new Set([
      "id",
      "storage",
      "mayContainUserContent",
      "constraints",
    ]);
    if (!hasExactKeys(value, expectedKeys)) {
      issues.push(`${path} has invalid cache-storage fields`);
      return;
    }
    if (!hasExactKeys(value.constraints, CACHE_CONSTRAINT_KEYS)) {
      issues.push(`${path}.constraints is invalid`);
      return;
    }
    if (
      value.constraints.origin !== "same-origin" ||
      value.constraints.method !== "GET" ||
      value.constraints.query !== "forbidden" ||
      value.constraints.source !== "build-allowlist"
    ) {
      issues.push(`${path}.constraints must describe the build allowlist`);
    }
    return;
  }

  if (value.storage === "service-worker-registration") {
    if (!hasExactKeys(value, SERVICE_WORKER_STATE_KEYS)) {
      issues.push(`${path} has invalid service-worker-registration fields`);
      return;
    }
    if (
      value.scope !== "site-base" ||
      value.script !== "same-origin-build-artifact"
    ) {
      issues.push(
        `${path} must describe the same-origin site Service Worker registration`,
      );
    }
    return;
  }

  issues.push(`${path}.storage is unsupported`);
}

function validateInventory(value, issues) {
  if (!hasExactKeys(value, INVENTORY_KEYS)) {
    issues.push("inventory must contain tools, operations and workflows only");
    return;
  }
  if (!Array.isArray(value.tools) || value.tools.length === 0) {
    issues.push("inventory.tools must be a non-empty array");
    return;
  }
  if (!Array.isArray(value.operations) || value.operations.length === 0) {
    issues.push("inventory.operations must be a non-empty array");
    return;
  }
  if (!Array.isArray(value.workflows) || value.workflows.length === 0) {
    issues.push("inventory.workflows must be a non-empty array");
    return;
  }

  const toolIds = new Set();
  value.tools.forEach((tool, index) => {
    const path = `inventory.tools[${index}]`;
    if (!hasExactKeys(tool, TOOL_KEYS)) {
      issues.push(`${path} has invalid fields`);
      return;
    }
    if (!isIdentifier(tool.id)) issues.push(`${path}.id is invalid`);
    if (
      typeof tool.route !== "string" ||
      !ROUTE_PATTERN.test(tool.route) ||
      tool.route.includes("?") ||
      tool.route.includes("#")
    ) {
      issues.push(`${path}.route must be a query-free relative route`);
    }
    if (tool.mode !== "local") issues.push(`${path}.mode must be local`);
    if (toolIds.has(tool.id)) issues.push(`${path}.id is duplicated`);
    toolIds.add(tool.id);
  });
  if (!recordsAreSortedById(value.tools)) {
    issues.push("inventory.tools must be sorted by id");
  }

  const operationIds = new Set();
  const operatedToolIds = new Set();
  value.operations.forEach((operation, index) => {
    const path = `inventory.operations[${index}]`;
    if (!hasExactKeys(operation, OPERATION_KEYS)) {
      issues.push(`${path} has invalid fields`);
      return;
    }
    if (!isIdentifier(operation.id)) issues.push(`${path}.id is invalid`);
    if (!isIdentifier(operation.toolId) || !toolIds.has(operation.toolId)) {
      issues.push(`${path}.toolId must reference a declared tool`);
    }
    if (operation.network !== "forbidden") {
      issues.push(`${path}.network must be forbidden`);
    }
    if (operation.persistence !== "forbidden") {
      issues.push(`${path}.persistence must be forbidden`);
    }
    if (!isSortedUniqueIdentifierList(operation.environment)) {
      issues.push(`${path}.environment must be a sorted identifier list`);
    }
    if (operationIds.has(operation.id)) {
      issues.push(`${path}.id is duplicated`);
    }
    operationIds.add(operation.id);
    operatedToolIds.add(operation.toolId);
  });
  if (!recordsAreSortedById(value.operations)) {
    issues.push("inventory.operations must be sorted by id");
  }
  for (const toolId of toolIds) {
    if (!operatedToolIds.has(toolId)) {
      issues.push(`inventory tool '${toolId}' has no declared operation`);
    }
  }

  const workflowIds = new Set();
  value.workflows.forEach((workflow, index) => {
    const path = `inventory.workflows[${index}]`;
    if (!hasExactKeys(workflow, WORKFLOW_KEYS)) {
      issues.push(`${path} has invalid fields`);
      return;
    }
    if (!isIdentifier(workflow.id)) issues.push(`${path}.id is invalid`);
    if (
      !Array.isArray(workflow.operationIds) ||
      workflow.operationIds.length === 0 ||
      !workflow.operationIds.every(
        (operationId) =>
          typeof operationId === "string" && operationIds.has(operationId),
      )
    ) {
      issues.push(`${path}.operationIds must reference declared operations`);
    }
    if (workflowIds.has(workflow.id)) issues.push(`${path}.id is duplicated`);
    workflowIds.add(workflow.id);
  });
  if (!recordsAreSortedById(value.workflows)) {
    issues.push("inventory.workflows must be sorted by id");
  }
}

export function validatePrivacyManifest(value) {
  const issues = [];
  if (!hasExactKeys(value, ROOT_KEYS)) {
    return Object.freeze({
      ok: false,
      issues: Object.freeze([
        "root must be a plain record containing documented fields only",
      ]),
    });
  }

  if (value.format !== PRIVACY_MANIFEST_FORMAT) {
    issues.push(`format must be '${PRIVACY_MANIFEST_FORMAT}'`);
  }
  if (value.version !== PRIVACY_MANIFEST_VERSION) {
    issues.push(`version must be ${PRIVACY_MANIFEST_VERSION}`);
  }

  if (!hasExactKeys(value.scope, SCOPE_KEYS)) {
    issues.push("scope is invalid");
  } else {
    if (value.scope.path !== "./") issues.push("scope.path must be './'");
    if (
      !sameOrderedValues(value.scope.covers, PRIVACY_MANIFEST_REQUIRED_COVERS)
    ) {
      issues.push("scope.covers must contain the complete ordered claim scope");
    }
    if (
      !sameOrderedValues(
        value.scope.excludes,
        PRIVACY_MANIFEST_REQUIRED_EXCLUDES,
      )
    ) {
      issues.push("scope.excludes must contain the complete ordered boundary");
    }
  }

  if (!hasExactKeys(value.data, DATA_KEYS)) {
    issues.push("data is invalid");
  } else if (
    value.data.processing !== "browser-local" ||
    value.data.userContentNetwork !== "forbidden" ||
    value.data.userContentPersistence !== "forbidden" ||
    value.data.telemetry !== "none" ||
    value.data.thirdPartyRuntime !== "bundled-dependencies-no-remote-code"
  ) {
    issues.push("data must declare the v1 local-only privacy policy");
  }

  if (
    !hasExactKeys(value.network, NETWORK_KEYS) ||
    !hasExactKeys(value.network?.publicResources, PUBLIC_RESOURCE_KEYS)
  ) {
    issues.push("network.publicResources is invalid");
  } else if (
    value.network.publicResources.origin !== "same-origin" ||
    !sameOrderedValues(value.network.publicResources.methods, ["GET"]) ||
    value.network.publicResources.mayContainUserContent !== false
  ) {
    issues.push("network.publicResources must allow only content-free GETs");
  }

  if (!hasExactKeys(value.interactions, INTERACTION_KEYS)) {
    issues.push("interactions is invalid");
  } else if (
    value.interactions.automaticClipboardRead !== "forbidden" ||
    value.interactions.clipboardWrite !== "user-gesture-only" ||
    value.interactions.downloads !== "user-gesture-only" ||
    value.interactions.objectUrls !== "temporary-and-revoked"
  ) {
    issues.push("interactions must declare the v1 user-gesture policy");
  }

  if (!Array.isArray(value.allowedState) || value.allowedState.length === 0) {
    issues.push("allowedState must be a non-empty array");
  } else {
    value.allowedState.forEach((entry, index) =>
      validateAllowedState(entry, index, issues),
    );
    const stateIds = value.allowedState.map((entry) => entry?.id);
    if (new Set(stateIds).size !== stateIds.length) {
      issues.push("allowedState ids must be unique");
    }
  }

  if (!hasExactKeys(value.enforcement, ENFORCEMENT_KEYS)) {
    issues.push("enforcement is invalid");
  } else {
    if (
      !hasExactKeys(value.enforcement.csp, CSP_KEYS) ||
      !sameOrderedValues(
        value.enforcement.csp?.requiredDirectives,
        PRIVACY_MANIFEST_REQUIRED_CSP_DIRECTIVES,
      )
    ) {
      issues.push("enforcement.csp must contain the required directives");
    }
    if (
      value.enforcement.operationWorker !== "fail-closed" ||
      value.enforcement.toolWorkers !== "fail-closed" ||
      value.enforcement.sourceScan !== "build-gate" ||
      value.enforcement.registryCoverage !== "build-gate"
    ) {
      issues.push("enforcement must declare the complete v1 build boundary");
    }
  }

  validateInventory(value.inventory, issues);

  if (!hasExactKeys(value.selfTest, SELF_TEST_KEYS)) {
    issues.push("selfTest is invalid");
  } else {
    if (
      value.selfTest.input !== "generated-synthetic-only" ||
      value.selfTest.acceptsUserContent !== false ||
      value.selfTest.retention !== "memory-only" ||
      value.selfTest.conclusion !== "current-site-current-run-only"
    ) {
      issues.push("selfTest must use the synthetic, memory-only v1 policy");
    }
    if (
      !sameOrderedValues(
        value.selfTest.targets,
        PRIVACY_MANIFEST_SELF_TEST_TARGETS,
      )
    ) {
      issues.push("selfTest.targets is incomplete");
    }
    if (
      !sameOrderedValues(
        value.selfTest.observations,
        PRIVACY_MANIFEST_SELF_TEST_OBSERVATIONS,
      )
    ) {
      issues.push("selfTest.observations is incomplete");
    }
    if (
      !sameOrderedValues(
        value.selfTest.doesNotAssess,
        PRIVACY_MANIFEST_SELF_TEST_NON_ASSESSMENTS,
      )
    ) {
      issues.push(
        "selfTest.doesNotAssess must contain the complete observation boundary",
      );
    }
  }

  if (issues.length > 0) {
    return Object.freeze({ ok: false, issues: Object.freeze(issues) });
  }
  return Object.freeze({ ok: true, value });
}

export function assertPrivacyManifest(value) {
  const result = validatePrivacyManifest(value);
  if (!result.ok) throw new PrivacyManifestValidationError(result.issues);
}

function deepFreeze(value, seen = new WeakSet()) {
  if (value === null || typeof value !== "object" || seen.has(value)) {
    return value;
  }
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) deepFreeze(value[key], seen);
  return Object.freeze(value);
}

export function freezePrivacyManifest(value) {
  assertPrivacyManifest(value);
  return deepFreeze(value);
}

export function serializePrivacyManifest(value) {
  assertPrivacyManifest(value);
  return `${JSON.stringify(value, null, 2)}\n`;
}

const PRIVACY_SOURCE_RULES = Object.freeze([
  ["network.fetch", /\bfetch\s*\(/gu],
  ["network.xml-http-request", /\bXMLHttpRequest\b/gu],
  ["network.web-socket", /\bWebSocket\b/gu],
  ["network.event-source", /\bEventSource\b/gu],
  ["network.web-transport", /\bWebTransport\b/gu],
  ["network.rtc-peer-connection", /\bRTCPeerConnection\b/gu],
  ["network.shared-worker", /\bSharedWorker\b/gu],
  ["network.broadcast-channel", /\bBroadcastChannel\b/gu],
  ["network.import-scripts", /\bimportScripts\s*\(/gu],
  ["network.send-beacon", /\bsendBeacon\s*\(/gu],
  ["storage.local", /\b(?:window\s*\.\s*)?localStorage\b/gu],
  ["storage.session", /\b(?:window\s*\.\s*)?sessionStorage\b/gu],
  ["storage.indexeddb", /\b(?:window\s*\.\s*)?indexedDB\b/gu],
  ["storage.cache", /\b(?:window\s*\.\s*)?caches\b/gu],
  ["storage.cookie", /\bdocument\s*\.\s*cookie\b/gu],
  [
    "storage.alias",
    /\bstorage\s*(?:\?\.|\.)\s*(?:getItem|setItem|removeItem|clear)\s*\(/gu,
  ],
  [
    "storage.cache-instance",
    /\bcache\s*\.\s*(?:keys|match|put|add|addAll|delete)\s*\(/gu,
  ],
  ["history.mutation", /\bhistory\s*\.\s*(?:pushState|replaceState)\s*\(/gu],
  [
    "clipboard.access",
    /\bnavigator\s*\.\s*clipboard\s*(?:\?\.|\.)\s*(?:read|readText|write|writeText)\b/gu,
  ],
  ["pwa.service-worker", /\bnavigator\s*\.\s*serviceWorker\b/gu],
  [
    "pwa.storage-estimate",
    /\bnavigator\s*\.\s*storage\s*(?:\?\.|\.)\s*estimate\b/gu,
  ],
  ["logging.console", /\bconsole\s*\./gu],
  ["dynamic.eval", /\beval\s*\(/gu],
  ["dynamic.function", /\bnew\s+Function\s*\(/gu],
]);

const CLIPBOARD_WRITE_TEXT_FILES = new Set([
  "src/components/ToolRelay.tsx",
  "src/components/workflows/WorkflowStudio.tsx",
  "src/components/tools/Base64CodecTool.tsx",
  "src/components/tools/CsvJsonConverterTool.tsx",
  "src/components/tools/HashGeneratorTool.tsx",
  "src/components/tools/JsonFormatterTool.tsx",
  "src/components/tools/JwtDecoderTool.tsx",
  "src/components/tools/QueryParamsTool.tsx",
  "src/components/tools/QrCodeTool.tsx",
  "src/components/tools/RegexTesterTool.tsx",
  "src/components/tools/TextDiffTool.tsx",
  "src/components/tools/TimestampConverterTool.tsx",
  "src/components/tools/UrlCodecTool.tsx",
  "src/components/tools/UuidGeneratorTool.tsx",
  "src/components/tools/YamlJsonConverterTool.tsx",
]);

const PRIVACY_SOURCE_EXPECTED_COUNTS = new Map([
  ["src/layouts/BaseLayout.astro", { "storage.local": 1 }],
  ["src/components/SiteHeader.astro", { "storage.local": 3 }],
  ["src/lib/tool-memory.ts", { "storage.local": 2, "storage.alias": 2 }],
  [
    "src/lib/workflow-recipe-library.ts",
    { "storage.local": 1, "storage.alias": 5 },
  ],
  [
    "src/privacy/self-test.ts",
    {
      "storage.local": 1,
      "storage.session": 1,
      "storage.indexeddb": 1,
      "storage.cache": 1,
    },
  ],
  [
    "src/privacy/observation.ts",
    {
      "storage.local": 4,
      "storage.session": 4,
      "storage.indexeddb": 3,
      "storage.cache": 4,
      "storage.cookie": 1,
      "storage.cache-instance": 2,
    },
  ],
  [
    "src/components/PwaManager.tsx",
    { "pwa.service-worker": 8, "pwa.storage-estimate": 2 },
  ],
  ["src/components/ToolRelay.tsx", { "clipboard.access": 2 }],
  ["src/components/workflows/WorkflowStudio.tsx", { "clipboard.access": 1 }],
  ...[...CLIPBOARD_WRITE_TEXT_FILES]
    .filter(
      (path) =>
        path.startsWith("src/components/tools/") &&
        path !== "src/components/tools/HashGeneratorTool.tsx",
    )
    .map((path) => [path, { "clipboard.access": 2 }]),
  ["src/components/tools/HashGeneratorTool.tsx", { "clipboard.access": 2 }],
]);

function normalizePrivacySourcePath(value) {
  return String(value).replaceAll("\\", "/").replace(/^\.\//u, "");
}

function maskPrivacySource(value) {
  let state = "code";
  let quote = "";
  let escaped = false;
  const templateExpressionDepths = [];
  const characters = [...value];

  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index];
    const next = characters[index + 1];

    if (state === "line-comment") {
      if (character === "\n") state = "code";
      else characters[index] = " ";
      continue;
    }
    if (state === "block-comment") {
      if (character === "*" && next === "/") {
        characters[index] = " ";
        characters[index + 1] = " ";
        index += 1;
        state = "code";
      } else if (character !== "\n") {
        characters[index] = " ";
      }
      continue;
    }
    if (state === "html-comment") {
      if (character === "-" && next === "-" && characters[index + 2] === ">") {
        characters[index] = " ";
        characters[index + 1] = " ";
        characters[index + 2] = " ";
        index += 2;
        state = "code";
      } else if (character !== "\n") {
        characters[index] = " ";
      }
      continue;
    }
    if (state === "template") {
      if (escaped) {
        if (character !== "\n") characters[index] = " ";
        escaped = false;
        continue;
      }
      if (character === "\\") {
        characters[index] = " ";
        escaped = true;
        continue;
      }
      if (character === "`") {
        characters[index] = " ";
        state = "code";
        continue;
      }
      if (character === "$" && next === "{") {
        characters[index] = " ";
        characters[index + 1] = " ";
        index += 1;
        templateExpressionDepths.push(1);
        state = "code";
        continue;
      }
      if (character !== "\n") characters[index] = " ";
      continue;
    }
    if (state === "string") {
      const closing = character === quote && !escaped;
      escaped = character === "\\" && !escaped;
      if (character !== "\n") characters[index] = " ";
      if (closing) {
        state = "code";
        quote = "";
        escaped = false;
      } else if (character !== "\\") {
        escaped = false;
      }
      continue;
    }

    if (templateExpressionDepths.length > 0) {
      const depthIndex = templateExpressionDepths.length - 1;
      if (character === "{") {
        templateExpressionDepths[depthIndex] += 1;
      } else if (character === "}") {
        templateExpressionDepths[depthIndex] -= 1;
        if (templateExpressionDepths[depthIndex] === 0) {
          characters[index] = " ";
          templateExpressionDepths.pop();
          state = "template";
          continue;
        }
      }
    }

    if (character === "/" && next === "/") {
      characters[index] = " ";
      characters[index + 1] = " ";
      index += 1;
      state = "line-comment";
    } else if (character === "/" && next === "*") {
      characters[index] = " ";
      characters[index + 1] = " ";
      index += 1;
      state = "block-comment";
    } else if (
      character === "<" &&
      next === "!" &&
      characters[index + 2] === "-" &&
      characters[index + 3] === "-"
    ) {
      characters[index] = " ";
      characters[index + 1] = " ";
      characters[index + 2] = " ";
      characters[index + 3] = " ";
      index += 3;
      state = "html-comment";
    } else if (character === "`") {
      characters[index] = " ";
      state = "template";
      escaped = false;
    } else if (character === '"' || character === "'") {
      quote = character;
      characters[index] = " ";
      state = "string";
      escaped = false;
    }
  }

  return characters.join("");
}

function lineAt(value, index) {
  return value.slice(0, index).split("\n").length;
}

function sourceFindingIsAllowed(path, rule, source, index, match) {
  const lineStart = source.lastIndexOf("\n", index - 1) + 1;
  const lineEnd = source.indexOf("\n", index);
  const line = source.slice(lineStart, lineEnd < 0 ? source.length : lineEnd);

  if (rule === "storage.local") {
    if (path === "src/layouts/BaseLayout.astro") {
      return /localStorage\.getItem\("online-tools-hub:theme"\)/u.test(line);
    }
    if (path === "src/components/SiteHeader.astro") {
      return /localStorage\.(?:getItem|removeItem|setItem)\(themeStorageKey/u.test(
        line,
      );
    }
    if (path === "src/lib/tool-memory.ts") {
      return (
        /return window\.localStorage/u.test(line) ||
        /event\.storageArea !== window\.localStorage/u.test(line)
      );
    }
    if (path === "src/lib/workflow-recipe-library.ts") {
      return /return window\.localStorage/u.test(line);
    }
  }

  if (rule === "storage.alias" && path === "src/lib/tool-memory.ts") {
    return (
      /storage\.getItem\(TOOL_MEMORY_STORAGE_KEY\)/u.test(line) ||
      /storage\?\.setItem\(TOOL_MEMORY_STORAGE_KEY, serializeToolMemory\(next\)\)/u.test(
        line,
      )
    );
  }

  if (
    rule === "storage.alias" &&
    path === "src/lib/workflow-recipe-library.ts"
  ) {
    const tail = source.slice(index, index + 240).replace(/\s+/gu, " ");
    return (
      /^storage\.getItem\(WORKFLOW_RECIPE_LIBRARY_STORAGE_KEY\)/u.test(tail) ||
      /^storage\.removeItem\(WORKFLOW_RECIPE_LIBRARY_STORAGE_KEY\)/u.test(
        tail,
      ) ||
      /^storage\.setItem\( WORKFLOW_RECIPE_LIBRARY_STORAGE_KEY, expectedSerialized, \)/u.test(
        tail,
      )
    );
  }

  if (
    path === "src/privacy/observation.ts" ||
    path === "src/privacy/self-test.ts"
  ) {
    if (
      rule === "storage.local" ||
      rule === "storage.session" ||
      rule === "storage.indexeddb" ||
      rule === "storage.cache" ||
      rule === "storage.cookie" ||
      rule === "storage.cache-instance"
    ) {
      return !/\.(?:setItem|removeItem|clear|put|add|addAll|delete)\s*\(/u.test(
        line,
      );
    }
  }

  if (rule === "clipboard.access" && CLIPBOARD_WRITE_TEXT_FILES.has(path)) {
    return /navigator\s*\.\s*clipboard\s*(?:\?\.|\.)\s*writeText\b/u.test(
      match,
    );
  }

  if (path === "src/components/PwaManager.tsx") {
    const tail = source.slice(index, index + 240).replace(/\s+/gu, " ");
    if (rule === "pwa.storage-estimate") {
      return /^navigator\.storage\??\.estimate\b/u.test(tail);
    }
    if (rule === "pwa.service-worker") {
      return (
        /^navigator\.serviceWorker\.(?:controller|ready)\b/u.test(tail) ||
        /^navigator\.serviceWorker\.(?:addEventListener|removeEventListener)\(\s*"controllerchange"/u.test(
          tail,
        ) ||
        /^navigator\.serviceWorker \.register\(workerUrl, \{ scope: normalizedBase, updateViaCache: "none", \}\)/u.test(
          tail,
        )
      );
    }
  }

  return false;
}

/**
 * Scans one production source file for privacy-sensitive browser entry points.
 * Every accepted use is tied to a narrow file-and-operation allowlist; comments
 * and string literals cannot satisfy or trigger a capability rule.
 */
export function scanPrivacySourceFile(relativePath, source) {
  if (typeof source !== "string") {
    return Object.freeze(["source must be a string"]);
  }
  const path = normalizePrivacySourcePath(relativePath);
  const masked = maskPrivacySource(source);
  const issues = [];
  const allowedCounts = new Map();

  for (const [rule, pattern] of PRIVACY_SOURCE_RULES) {
    pattern.lastIndex = 0;
    for (const match of masked.matchAll(pattern)) {
      const index = match.index ?? 0;
      if (!sourceFindingIsAllowed(path, rule, source, index, match[0])) {
        issues.push(`${path}:${lineAt(source, index)} uses ${rule}`);
      } else {
        allowedCounts.set(rule, (allowedCounts.get(rule) ?? 0) + 1);
      }
    }
  }

  for (const match of source.matchAll(
    /\bimport\s*\(\s*["'](?:https?:|\/\/)/gu,
  )) {
    const index = match.index ?? 0;
    if (/\bimport\s*\(/u.test(masked.slice(index, index + match[0].length))) {
      issues.push(
        `${path}:${lineAt(source, index)} uses network.remote-dynamic-import`,
      );
    }
  }

  const expectedCounts = PRIVACY_SOURCE_EXPECTED_COUNTS.get(path);
  if (expectedCounts !== undefined) {
    for (const [rule, expected] of Object.entries(expectedCounts)) {
      const actual = allowedCounts.get(rule) ?? 0;
      if (actual !== expected) {
        issues.push(
          `${path} allowlist count for ${rule} changed (${actual}/${expected})`,
        );
      }
    }
    for (const rule of allowedCounts.keys()) {
      if (!Object.hasOwn(expectedCounts, rule)) {
        issues.push(`${path} uses an uncounted allowlist rule ${rule}`);
      }
    }
  }

  return Object.freeze(issues);
}

export const PRIVACY_MANIFEST_FORMAT: "online-tools-hub/privacy-manifest";
export const PRIVACY_MANIFEST_VERSION: 1;

export type PrivacyManifestScopeCover =
  | "site-code"
  | "tool-runtime"
  | "operation-runtime"
  | "workflow-runtime"
  | "service-worker";

export type PrivacyManifestScopeExclusion =
  | "browser-extensions"
  | "browser-implementation"
  | "operating-system"
  | "network-infrastructure"
  | "hosting-logs"
  | "other-tabs-and-sites";

export type PrivacyManifestSelfTestTarget =
  "operation-worker" | "built-in-workflow";

export type PrivacyManifestSelfTestObservation =
  | "csp"
  | "security-policy-violations"
  | "resource-urls"
  | "location-and-history"
  | "cookie-and-web-storage"
  | "indexeddb-database-names"
  | "cache-storage-requests-and-bodies"
  | "runtime-resource-counters";

export type PrivacyManifestSelfTestNonAssessment =
  PrivacyManifestScopeExclusion | "indexeddb-record-values";

export interface PrivacyManifestLocalStorageState {
  readonly id: string;
  readonly storage: "local-storage";
  readonly key: string;
  readonly fields?: readonly string[];
  readonly mayContainUserContent: false;
}

export interface PrivacyManifestCacheStorageState {
  readonly id: string;
  readonly storage: "cache-storage";
  readonly mayContainUserContent: false;
  readonly constraints: {
    readonly origin: "same-origin";
    readonly method: "GET";
    readonly query: "forbidden";
    readonly source: "build-allowlist";
  };
}

export interface PrivacyManifestServiceWorkerRegistrationState {
  readonly id: string;
  readonly storage: "service-worker-registration";
  readonly scope: "site-base";
  readonly script: "same-origin-build-artifact";
  readonly mayContainUserContent: false;
}

export interface PrivacyManifestV1 {
  readonly format: typeof PRIVACY_MANIFEST_FORMAT;
  readonly version: typeof PRIVACY_MANIFEST_VERSION;
  readonly scope: {
    readonly path: "./";
    readonly covers: readonly PrivacyManifestScopeCover[];
    readonly excludes: readonly PrivacyManifestScopeExclusion[];
  };
  readonly data: {
    readonly processing: "browser-local";
    readonly userContentNetwork: "forbidden";
    readonly userContentPersistence: "forbidden";
    readonly telemetry: "none";
    readonly thirdPartyRuntime: "bundled-dependencies-no-remote-code";
  };
  readonly network: {
    readonly publicResources: {
      readonly origin: "same-origin";
      readonly methods: readonly ["GET"];
      readonly mayContainUserContent: false;
    };
  };
  readonly interactions: {
    readonly automaticClipboardRead: "forbidden";
    readonly clipboardWrite: "user-gesture-only";
    readonly downloads: "user-gesture-only";
    readonly objectUrls: "temporary-and-revoked";
  };
  readonly allowedState: readonly (
    | PrivacyManifestLocalStorageState
    | PrivacyManifestCacheStorageState
    | PrivacyManifestServiceWorkerRegistrationState
  )[];
  readonly enforcement: {
    readonly csp: { readonly requiredDirectives: readonly string[] };
    readonly operationWorker: "fail-closed";
    readonly toolWorkers: "fail-closed";
    readonly sourceScan: "build-gate";
    readonly registryCoverage: "build-gate";
  };
  readonly inventory: {
    readonly tools: readonly {
      readonly id: string;
      readonly route: string;
      readonly mode: "local";
    }[];
    readonly operations: readonly {
      readonly id: string;
      readonly toolId: string;
      readonly network: "forbidden";
      readonly persistence: "forbidden";
      readonly environment: readonly string[];
    }[];
    readonly workflows: readonly {
      readonly id: string;
      readonly operationIds: readonly string[];
    }[];
  };
  readonly selfTest: {
    readonly input: "generated-synthetic-only";
    readonly acceptsUserContent: false;
    readonly retention: "memory-only";
    readonly targets: readonly PrivacyManifestSelfTestTarget[];
    readonly observations: readonly PrivacyManifestSelfTestObservation[];
    readonly conclusion: "current-site-current-run-only";
    readonly doesNotAssess: readonly PrivacyManifestSelfTestNonAssessment[];
  };
}

export const PRIVACY_MANIFEST_REQUIRED_COVERS: readonly PrivacyManifestScopeCover[];
export const PRIVACY_MANIFEST_REQUIRED_EXCLUDES: readonly PrivacyManifestScopeExclusion[];
export const PRIVACY_MANIFEST_REQUIRED_CSP_DIRECTIVES: readonly string[];
export const PRIVACY_MANIFEST_SELF_TEST_TARGETS: readonly PrivacyManifestSelfTestTarget[];
export const PRIVACY_MANIFEST_SELF_TEST_OBSERVATIONS: readonly PrivacyManifestSelfTestObservation[];
export const PRIVACY_MANIFEST_SELF_TEST_NON_ASSESSMENTS: readonly PrivacyManifestSelfTestNonAssessment[];

export class PrivacyManifestValidationError extends TypeError {
  readonly issues: readonly string[];
}

export type PrivacyManifestValidationResult =
  | Readonly<{ ok: true; value: PrivacyManifestV1 }>
  | Readonly<{ ok: false; issues: readonly string[] }>;

export function validatePrivacyManifest(
  value: unknown,
): PrivacyManifestValidationResult;
export function assertPrivacyManifest(
  value: unknown,
): asserts value is PrivacyManifestV1;
export function freezePrivacyManifest(value: unknown): PrivacyManifestV1;
export function serializePrivacyManifest(value: unknown): string;
export function scanPrivacySourceFile(
  relativePath: string,
  source: unknown,
): readonly string[];

export const PWA_OFFLINE_PROTOCOL_VERSION: 1;
export const MAX_PWA_PACKAGE_ENTRIES: 512;
export const MAX_PWA_PACKAGE_BYTES: number;
export const MAX_PWA_ENTRY_BYTES: number;
export const MAX_PWA_SHELL_BYTES: number;

export type PwaBuildEntryKind =
  | "document"
  | "style"
  | "script"
  | "font"
  | "image"
  | "manifest"
  | "wasm"
  | "data";

export type PwaBuildEntry = Readonly<{
  url: string;
  bytes: number;
  sha256: string;
  kind: PwaBuildEntryKind;
}>;

export type PwaBuildManifest = Readonly<{
  protocolVersion: 1;
  version: string;
  basePath: string;
  entries: readonly PwaBuildEntry[];
  shellEntries: readonly PwaBuildEntry[];
  urls: readonly string[];
  shellUrls: readonly string[];
  totalBytes: number;
  shellBytes: number;
}>;

export function normalizeBasePath(value: string): string;
export function filePathToPublicUrl(
  relativePath: string,
  basePath: string,
): string;
export function shouldPrecache(relativePath: string): boolean;
export function createPrecacheManifest(
  distDirectory: string,
  basePath: string,
): Promise<PwaBuildManifest>;
export function createServiceWorkerSource(options: {
  basePath: string;
  version: string;
  entries: readonly PwaBuildEntry[];
  shellUrls: readonly string[];
}): string;
export function generateServiceWorker(options: {
  distDirectory: string;
  basePath: string;
}): Promise<PwaBuildManifest & { destination: string }>;

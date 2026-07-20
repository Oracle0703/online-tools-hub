export function normalizeBasePath(value: string): string;
export function filePathToPublicUrl(
  relativePath: string,
  basePath: string,
): string;
export function shouldPrecache(relativePath: string): boolean;
export function createPrecacheManifest(
  distDirectory: string,
  basePath: string,
): Promise<{ version: string; urls: string[] }>;
export function createServiceWorkerSource(options: {
  basePath: string;
  version: string;
  urls: string[];
}): string;
export function generateServiceWorker(options: {
  distDirectory: string;
  basePath: string;
}): Promise<{ version: string; urls: string[]; destination: string }>;

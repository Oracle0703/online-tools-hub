const localhostNames = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function normalizeBaseUrl(baseUrl: string): string {
  const pathname = baseUrl.split(/[?#]/u, 1)[0] ?? "/";
  const normalized = `/${pathname}`.replace(/\/{2,}/gu, "/");
  const stripped = normalized.replace(/^\/+|\/+$/gu, "");
  return stripped ? `/${stripped}/` : "/";
}

export function pwaAssetUrl(baseUrl: string, filename: string): string {
  const base = normalizeBaseUrl(baseUrl);
  const cleanFilename = filename.replace(/^\/+|\/+$/gu, "");
  return `${base}${cleanFilename}`;
}

export function canRegisterServiceWorker(options: {
  hasServiceWorker: boolean;
  isSecureContext: boolean;
  hostname: string;
}): boolean {
  return (
    options.hasServiceWorker &&
    (options.isSecureContext || localhostNames.has(options.hostname))
  );
}

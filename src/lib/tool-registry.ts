/**
 * Backwards-compatible catalog entry point.
 *
 * Keep this module free of React components and runtime loaders: it is used by
 * layouts, content pages, search islands and SEO generation. Tool UI loading
 * belongs exclusively to `tool-runtime.ts`.
 */
export * from "./tool-catalog";

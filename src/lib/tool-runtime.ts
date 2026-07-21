import type { AstroComponentFactory } from "astro/runtime/server/index.js";

import base64CodecStylesheet from "../components/tools/Base64CodecTool.css?url";
import csvJsonConverterStylesheet from "../components/tools/CsvJsonConverterTool.css?url";
import hashGeneratorStylesheet from "../components/tools/HashGeneratorTool.css?url";
import imageCompressorStylesheet from "../components/tools/ImageCompressorTool.css?url";
import jsonFormatterStylesheet from "../components/tools/JsonFormatterTool.css?url";
import jwtDecoderStylesheet from "../components/tools/JwtDecoderTool.css?url";
import queryParamsStylesheet from "../components/tools/QueryParamsTool.css?url";
import textDiffStylesheet from "../components/tools/TextDiffTool.css?url";
import timestampConverterStylesheet from "../components/tools/TimestampConverterTool.css?url";
import urlCodecStylesheet from "../components/tools/UrlCodecTool.css?url";
import uuidGeneratorStylesheet from "../components/tools/UuidGeneratorTool.css?url";
import yamlJsonConverterStylesheet from "../components/tools/YamlJsonConverterTool.css?url";
import type { ToolSlug } from "./tool-catalog";

export type ToolRuntimeComponentModule = {
  default: AstroComponentFactory;
};

export type ToolRuntimeRegistration = {
  load: () => Promise<ToolRuntimeComponentModule>;
  stylesheet: string;
};

export type LoadedToolRuntime = {
  Component: AstroComponentFactory;
  stylesheet: string;
};

/**
 * The only map from catalog slugs to interactive tool UI and styles.
 *
 * The Astro wrappers are lazy and each wrapper statically hydrates exactly one
 * React tool. Tool CSS is emitted as a URL and linked only by the selected
 * route, preventing Vite from hoisting every tool stylesheet into each page.
 */
export const toolRuntimeRegistry: Readonly<
  Record<ToolSlug, ToolRuntimeRegistration>
> = {
  "json-formatter": {
    load: () =>
      import("../components/tools/runtime/wrappers/JsonFormatterRuntime.astro"),
    stylesheet: jsonFormatterStylesheet,
  },
  "base64-codec": {
    load: () =>
      import("../components/tools/runtime/wrappers/Base64CodecRuntime.astro"),
    stylesheet: base64CodecStylesheet,
  },
  "url-codec": {
    load: () =>
      import("../components/tools/runtime/wrappers/UrlCodecRuntime.astro"),
    stylesheet: urlCodecStylesheet,
  },
  "unix-timestamp": {
    load: () =>
      import("../components/tools/runtime/wrappers/TimestampConverterRuntime.astro"),
    stylesheet: timestampConverterStylesheet,
  },
  "uuid-generator": {
    load: () =>
      import("../components/tools/runtime/wrappers/UuidGeneratorRuntime.astro"),
    stylesheet: uuidGeneratorStylesheet,
  },
  "image-compressor": {
    load: () =>
      import("../components/tools/runtime/wrappers/ImageCompressorRuntime.astro"),
    stylesheet: imageCompressorStylesheet,
  },
  "text-diff": {
    load: () =>
      import("../components/tools/runtime/wrappers/TextDiffRuntime.astro"),
    stylesheet: textDiffStylesheet,
  },
  "hash-generator": {
    load: () =>
      import("../components/tools/runtime/wrappers/HashGeneratorRuntime.astro"),
    stylesheet: hashGeneratorStylesheet,
  },
  "yaml-json-converter": {
    load: () =>
      import("../components/tools/runtime/wrappers/YamlJsonConverterRuntime.astro"),
    stylesheet: yamlJsonConverterStylesheet,
  },
  "jwt-decoder": {
    load: () =>
      import("../components/tools/runtime/wrappers/JwtDecoderRuntime.astro"),
    stylesheet: jwtDecoderStylesheet,
  },
  "csv-json-converter": {
    load: () =>
      import("../components/tools/runtime/wrappers/CsvJsonConverterRuntime.astro"),
    stylesheet: csvJsonConverterStylesheet,
  },
  "query-params": {
    load: () =>
      import("../components/tools/runtime/wrappers/QueryParamsRuntime.astro"),
    stylesheet: queryParamsStylesheet,
  },
};

export function getToolRuntimeRegistration(
  slug: string,
): ToolRuntimeRegistration | undefined {
  if (!Object.hasOwn(toolRuntimeRegistry, slug)) return undefined;

  return toolRuntimeRegistry[slug as ToolSlug];
}

export async function loadToolRuntime(
  slug: string,
): Promise<LoadedToolRuntime> {
  const registration = getToolRuntimeRegistration(slug);
  if (!registration) {
    throw new Error(`Missing runtime component for tool: ${slug}`);
  }

  const module = await registration.load();
  return {
    Component: module.default,
    stylesheet: registration.stylesheet,
  };
}

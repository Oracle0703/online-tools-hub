import { gzipSync } from "node:zlib";
import path from "node:path";

const { posix } = path;
const localAssetExtensionPattern = /\.(?:css|m?js)$/i;

export const pageResourceBudgets = Object.freeze({
  content: 120 * 1024,
  home: 160 * 1024,
  tool: 180 * 1024,
  studio: 260 * 1024,
});

function uniqueMatches(source, pattern, mapMatch) {
  const matches = [];
  const seen = new Set();

  for (const match of source.matchAll(pattern)) {
    const value = mapMatch(match);
    const key = JSON.stringify(value);
    if (seen.has(key)) continue;
    seen.add(key);
    matches.push(value);
  }

  return matches;
}

export function extractHtmlResourceReferences(html) {
  const direct = uniqueMatches(
    html,
    /\b(?:src|href)\s*=\s*(["'])(.*?)\1/gi,
    (match) => match[2],
  ).filter((specifier) =>
    localAssetExtensionPattern.test(withoutQueryOrHash(specifier)),
  );
  const islands = uniqueMatches(
    html,
    /\b(component-url|renderer-url)\s*=\s*(["'])(.*?)\2/gi,
    (match) => ({ attribute: match[1].toLowerCase(), specifier: match[3] }),
  ).filter(({ specifier }) =>
    localAssetExtensionPattern.test(withoutQueryOrHash(specifier)),
  );

  return { direct, islands };
}

export function extractJavaScriptResourceReferences(source) {
  const imports = [];
  const seenImports = new Set();
  const addImport = (specifier, kind) => {
    if (!localAssetExtensionPattern.test(withoutQueryOrHash(specifier))) return;
    const key = `${kind}:${specifier}`;
    if (seenImports.has(key)) return;
    seenImports.add(key);
    imports.push({ kind, specifier });
  };

  for (const match of source.matchAll(
    /\bimport\s*\(\s*(["'`])([^"'`]+)\1\s*\)/g,
  )) {
    addImport(match[2], "dynamic-import");
  }

  for (const match of source.matchAll(
    /\b(?:import(?!\s*\.)|export)\s*(?:[^"'`]*?\bfrom\s*)?(["'`])([^"'`]+)\1/g,
  )) {
    addImport(match[2], "static-import");
  }

  const workers = [];
  const seenWorkers = new Set();
  const addWorker = (specifier) => {
    if (!localAssetExtensionPattern.test(withoutQueryOrHash(specifier))) return;
    if (seenWorkers.has(specifier)) return;
    seenWorkers.add(specifier);
    workers.push(specifier);
  };

  for (const match of source.matchAll(
    /\bnew\s+(?:Shared)?Worker\s*\(\s*new\s+URL\s*\(\s*(["'`])([^"'`]+)\1/g,
  )) {
    addWorker(match[2]);
  }

  for (const match of source.matchAll(
    /\bnew\s+(?:Shared)?Worker\s*\(\s*(["'`])([^"'`]+)\1/g,
  )) {
    addWorker(match[2]);
  }

  return { imports, workers };
}

export function extractCssResourceReferences(source) {
  return uniqueMatches(
    source,
    /@import\s+(?:url\(\s*)?(?:(["'])(.*?)\1|([^"'()\s;]+))\s*\)?/gi,
    (match) => match[2] ?? match[3],
  ).filter((specifier) => /\.css$/i.test(withoutQueryOrHash(specifier)));
}

function normalizedBasePath(basePath) {
  const withLeadingSlash = basePath.startsWith("/") ? basePath : `/${basePath}`;
  return withLeadingSlash.endsWith("/")
    ? withLeadingSlash
    : `${withLeadingSlash}/`;
}

function withoutQueryOrHash(specifier) {
  return specifier.split(/[?#]/, 1)[0];
}

export function resolveLocalAsset(specifier, importerPath, basePath = "/") {
  let pathname = withoutQueryOrHash(specifier.trim());
  if (!pathname || pathname.startsWith("//")) return null;
  if (/^[a-z][a-z\d+.-]*:/i.test(pathname)) return null;

  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    return null;
  }

  const base = normalizedBasePath(basePath);
  let resolved;
  if (pathname.startsWith(base)) {
    resolved = pathname.slice(base.length);
  } else if (pathname.startsWith("/")) {
    resolved = pathname.slice(1);
  } else {
    resolved = posix.join(posix.dirname(importerPath), pathname);
  }

  resolved = posix.normalize(resolved);
  if (
    !resolved ||
    resolved === "." ||
    resolved === ".." ||
    resolved.startsWith("../")
  )
    return null;
  return resolved;
}

export function classifyPageResourceBudget(route) {
  const normalizedRoute = route.replace(/^\/+/, "");
  if (normalizedRoute === "index.html") return "home";
  if (/^tools\/[^/]+\/index\.html$/.test(normalizedRoute)) return "tool";
  if (/^(?:studio|__runtime)(?:\/|$)/.test(normalizedRoute)) return "studio";
  return "content";
}

function assetKind(assetPath) {
  if (/\.css$/i.test(assetPath)) return "css";
  if (/\.m?js$/i.test(assetPath)) return "javascript";
  return "other";
}

function routeLabel(route) {
  if (route === "index.html") return "/";
  if (route === "404.html") return "/404.html";
  if (route.endsWith("/index.html"))
    return `/${route.slice(0, -"index.html".length)}`;
  return `/${route}`;
}

export async function buildPageResourceGraph({
  route,
  html,
  basePath = "/",
  loadAsset,
  gzipSize = (content) => gzipSync(content).byteLength,
}) {
  const htmlBuffer = Buffer.isBuffer(html) ? html : Buffer.from(html);
  const htmlText = htmlBuffer.toString("utf8");
  const assets = new Map();
  const visitedRealms = new Set();
  const queue = [];

  const enqueue = (specifier, importerPath, realm, reason) => {
    const assetPath = resolveLocalAsset(specifier, importerPath, basePath);
    if (!assetPath) return;
    queue.push({ assetPath, realm, reason, specifier });
  };

  const htmlReferences = extractHtmlResourceReferences(htmlText);
  for (const specifier of htmlReferences.direct) {
    enqueue(specifier, route, "main", "html-direct");
  }
  for (const { attribute, specifier } of htmlReferences.islands) {
    enqueue(specifier, route, "main", `astro-${attribute}`);
  }

  while (queue.length > 0) {
    const edge = queue.shift();
    const realmKey = `${edge.realm}:${edge.assetPath}`;
    if (visitedRealms.has(realmKey)) {
      const existingAsset = assets.get(edge.assetPath);
      existingAsset?.reasons.add(edge.reason);
      continue;
    }
    visitedRealms.add(realmKey);

    let asset = assets.get(edge.assetPath);
    if (!asset) {
      let content;
      try {
        content = await loadAsset(edge.assetPath);
      } catch (error) {
        throw new Error(
          `Failed to load ${edge.assetPath}, referenced by ${edge.specifier} from ${route}: ${error.message}`,
          { cause: error },
        );
      }
      const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
      asset = {
        path: edge.assetPath,
        kind: assetKind(edge.assetPath),
        bytes: buffer.byteLength,
        gzipBytes: gzipSize(buffer),
        content: buffer,
        realms: new Set(),
        reasons: new Set(),
        workerEntry: false,
      };
      assets.set(edge.assetPath, asset);
    }

    asset.realms.add(edge.realm);
    asset.reasons.add(edge.reason);
    if (edge.reason === "worker") asset.workerEntry = true;

    if (asset.kind === "css") {
      for (const cssSpecifier of extractCssResourceReferences(
        asset.content.toString("utf8"),
      )) {
        enqueue(cssSpecifier, asset.path, edge.realm, "css-import");
      }
      continue;
    }
    if (asset.kind !== "javascript") continue;
    const references = extractJavaScriptResourceReferences(
      asset.content.toString("utf8"),
    );
    for (const dependency of references.imports) {
      enqueue(dependency.specifier, asset.path, edge.realm, dependency.kind);
    }
    for (const workerSpecifier of references.workers) {
      enqueue(workerSpecifier, asset.path, "worker", "worker");
    }
  }

  const breakdown = {
    html: gzipSize(htmlBuffer),
    css: 0,
    javascript: 0,
    workerJavascript: 0,
    other: 0,
  };
  const publicAssets = [];

  for (const asset of assets.values()) {
    publicAssets.push({
      path: asset.path,
      kind: asset.kind,
      bytes: asset.bytes,
      gzipBytes: asset.gzipBytes,
      workerEntry: asset.workerEntry,
      realms: [...asset.realms].sort(),
      reasons: [...asset.reasons].sort(),
    });
    if (asset.kind === "css") {
      breakdown.css += asset.gzipBytes;
    } else if (asset.kind === "javascript" && !asset.realms.has("main")) {
      breakdown.workerJavascript += asset.gzipBytes;
    } else if (asset.kind === "javascript") {
      breakdown.javascript += asset.gzipBytes;
    } else {
      breakdown.other += asset.gzipBytes;
    }
  }

  publicAssets.sort(
    (left, right) =>
      right.gzipBytes - left.gzipBytes || left.path.localeCompare(right.path),
  );
  const totalGzipBytes = Object.values(breakdown).reduce(
    (total, value) => total + value,
    0,
  );
  const category = classifyPageResourceBudget(route);
  const budgetBytes = pageResourceBudgets[category];

  return {
    route,
    routeLabel: routeLabel(route),
    category,
    budgetBytes,
    totalGzipBytes,
    utilization: totalGzipBytes / budgetBytes,
    withinBudget: totalGzipBytes <= budgetBytes,
    breakdown,
    assets: publicAssets,
  };
}

export function formatBytes(bytes) {
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

export function summarizePageResourceGraphs(graphs) {
  return ["home", "content", "tool", "studio"].map((category) => {
    const categoryGraphs = graphs
      .filter((graph) => graph.category === category)
      .toSorted((left, right) => left.totalGzipBytes - right.totalGzipBytes);
    if (categoryGraphs.length === 0) {
      return {
        category,
        budgetBytes: pageResourceBudgets[category],
        count: 0,
        typicalGzipBytes: null,
        maximum: null,
      };
    }

    const typical = categoryGraphs[Math.floor(categoryGraphs.length / 2)];
    const maximum = categoryGraphs.at(-1);
    return {
      category,
      budgetBytes: pageResourceBudgets[category],
      count: categoryGraphs.length,
      typicalGzipBytes: typical.totalGzipBytes,
      maximum: {
        routeLabel: maximum.routeLabel,
        gzipBytes: maximum.totalGzipBytes,
      },
    };
  });
}

export function formatPageResourceBudgetReport(graphs) {
  const sortedGraphs = [...graphs].sort(
    (left, right) =>
      ["home", "content", "tool", "studio"].indexOf(left.category) -
        ["home", "content", "tool", "studio"].indexOf(right.category) ||
      left.routeLabel.localeCompare(right.routeLabel),
  );
  const lines = [
    "Page resource graph budgets (deduplicated gzip)",
    `limits: content ${formatBytes(pageResourceBudgets.content)}, home ${formatBytes(pageResourceBudgets.home)}, tool ${formatBytes(pageResourceBudgets.tool)}, studio ${formatBytes(pageResourceBudgets.studio)}`,
    "status type     route                                    total / budget    html    css     main-js worker-js assets",
  ];

  for (const graph of sortedGraphs) {
    const status = graph.withinBudget ? "OK" : "FAIL";
    const route =
      graph.routeLabel.length > 40
        ? `${graph.routeLabel.slice(0, 37)}...`
        : graph.routeLabel;
    lines.push(
      `${status.padEnd(6)} ${graph.category.padEnd(8)} ${route.padEnd(40)} ` +
        `${formatBytes(graph.totalGzipBytes).padStart(9)} / ${formatBytes(graph.budgetBytes).padEnd(9)} ` +
        `${formatBytes(graph.breakdown.html).padStart(8)} ` +
        `${formatBytes(graph.breakdown.css).padStart(8)} ` +
        `${formatBytes(graph.breakdown.javascript).padStart(8)} ` +
        `${formatBytes(graph.breakdown.workerJavascript).padStart(9)} ` +
        `${String(graph.assets.length).padStart(6)}`,
    );
  }

  lines.push("", "Category summary (typical = median page)");
  for (const summary of summarizePageResourceGraphs(sortedGraphs)) {
    if (summary.count === 0) {
      lines.push(
        `  ${summary.category.padEnd(8)} no routes yet; reserved budget ${formatBytes(summary.budgetBytes)}`,
      );
      continue;
    }
    lines.push(
      `  ${summary.category.padEnd(8)} ${String(summary.count).padStart(2)} routes; typical ${formatBytes(summary.typicalGzipBytes).padStart(9)}; max ${formatBytes(summary.maximum.gzipBytes).padStart(9)} ${summary.maximum.routeLabel}`,
    );
  }

  const failures = sortedGraphs.filter((graph) => !graph.withinBudget);
  for (const graph of failures) {
    lines.push("", `Largest assets for ${graph.routeLabel}:`);
    for (const asset of graph.assets.slice(0, 5)) {
      const worker = asset.workerEntry ? " [worker]" : "";
      lines.push(
        `  ${formatBytes(asset.gzipBytes).padStart(9)}  ${asset.path}${worker}`,
      );
    }
  }

  return lines.join("\n");
}

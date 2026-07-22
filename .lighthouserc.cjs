module.exports = {
  ci: {
    collect: {
      startServerCommand: "npm run preview -- --host 127.0.0.1 --port 4321",
      startServerReadyPattern: "Local",
      startServerReadyTimeout: 120000,
      numberOfRuns: 3,
      url: [
        "http://127.0.0.1:4321/online-tools-hub/",
        "http://127.0.0.1:4321/online-tools-hub/tools/json-formatter/",
        "http://127.0.0.1:4321/online-tools-hub/tools/base64-codec/",
        "http://127.0.0.1:4321/online-tools-hub/tools/url-codec/",
        "http://127.0.0.1:4321/online-tools-hub/tools/unix-timestamp/",
        "http://127.0.0.1:4321/online-tools-hub/tools/uuid-generator/",
        "http://127.0.0.1:4321/online-tools-hub/tools/image-compressor/",
        "http://127.0.0.1:4321/online-tools-hub/tools/text-diff/",
        "http://127.0.0.1:4321/online-tools-hub/tools/regex-tester/",
        "http://127.0.0.1:4321/online-tools-hub/tools/hash-generator/",
        "http://127.0.0.1:4321/online-tools-hub/tools/yaml-json-converter/",
        "http://127.0.0.1:4321/online-tools-hub/tools/jwt-decoder/",
        "http://127.0.0.1:4321/online-tools-hub/tools/csv-json-converter/",
        "http://127.0.0.1:4321/online-tools-hub/tools/query-params/",
        "http://127.0.0.1:4321/online-tools-hub/workflows/",
        "http://127.0.0.1:4321/online-tools-hub/workflows/new/",
        "http://127.0.0.1:4321/online-tools-hub/workflows/base64-json-inspect/",
        "http://127.0.0.1:4321/online-tools-hub/workflows/png-palette-sha256/",
        "http://127.0.0.1:4321/online-tools-hub/guides/",
        "http://127.0.0.1:4321/online-tools-hub/privacy/",
        "http://127.0.0.1:4321/online-tools-hub/changelog/",
      ],
      settings: {
        onlyCategories: [
          "performance",
          "accessibility",
          "best-practices",
          "seo",
        ],
        chromeFlags: "--headless=new --no-sandbox --disable-dev-shm-usage",
      },
    },
    assert: {
      assertions: {
        "categories:performance": [
          "error",
          { minScore: 0.9, aggregationMethod: "median-run" },
        ],
        "categories:accessibility": [
          "error",
          { minScore: 0.9, aggregationMethod: "pessimistic" },
        ],
        "categories:best-practices": [
          "error",
          { minScore: 0.9, aggregationMethod: "pessimistic" },
        ],
        "categories:seo": [
          "error",
          { minScore: 0.9, aggregationMethod: "pessimistic" },
        ],
      },
    },
    upload: {
      target: "filesystem",
      outputDir: "./lighthouse-reports",
      reportFilenamePattern: "%%PATHNAME%%-%%DATETIME%%-report.%%EXTENSION%%",
    },
  },
};

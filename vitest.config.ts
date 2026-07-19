import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "tests/unit/**/*.test.ts",
      "src/**/*.test.ts",
      "src/**/*.spec.ts",
    ],
    exclude: ["tests/e2e/**", "node_modules/**", "dist/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["src/lib/**/*.ts", "src/tools/**/*.ts"],
      exclude: [
        "src/tools/**/*.d.ts",
        "src/tools/**/*.test.ts",
        "src/tools/**/*.spec.ts",
        "src/tools/**/index.ts",
      ],
      thresholds: {
        branches: 80,
        functions: 80,
        lines: 80,
        statements: 80,
      },
    },
  },
});

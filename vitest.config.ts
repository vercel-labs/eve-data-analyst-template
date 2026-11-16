import { defineConfig } from "vitest/config";

const shared = {
  clearMocks: true,
  mockReset: true,
  restoreMocks: true,
  unstubEnvs: true,
  unstubGlobals: true,
};

export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: {
          ...shared,
          include: [
            "agent/**/*.test.ts",
            "evals/**/*.test.ts",
            "scripts/**/*.test.ts",
          ],
          name: "unit",
        },
      },
      {
        extends: true,
        test: {
          ...shared,
          // Every file shares one in-process Postgres with a single session, so files run one at a time.
          fileParallelism: false,
          globalSetup: ["tests/support/global-setup.ts"],
          include: ["tests/behavior/**/*.test.ts"],
          name: "behavior",
        },
      },
      {
        extends: true,
        test: {
          ...shared,
          // One eve dev server and one in-process Postgres serve every file, so files run one at a time.
          fileParallelism: false,
          globalSetup: ["tests/e2e/global-setup.ts"],
          include: ["tests/e2e/*.test.ts"],
          name: "e2e",
          testTimeout: 60_000,
        },
      },
      {
        extends: true,
        test: {
          // Type-level tests: compiled with the project's own tsc and reported per test.
          include: [],
          name: "types",
          typecheck: {
            enabled: true,
            include: ["tests/types/**/*.test-d.ts"],
            only: true,
          },
        },
      },
    ],
  },
});

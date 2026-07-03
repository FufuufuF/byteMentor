import { defineConfig } from "vitest/config";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@byte-mentor/core": resolve(rootDir, "packages/core/src/index.ts"),
      "@byte-mentor/session": resolve(rootDir, "packages/session/src/index.ts"),
      "@byte-mentor/agent": resolve(rootDir, "packages/agent/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    passWithNoTests: true,
  },
});

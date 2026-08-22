import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@zaff/contracts": fileURLToPath(
        new URL("./packages/contracts/src/index.ts", import.meta.url)
      ),
      "@zaff/db": fileURLToPath(
        new URL("./packages/db/src/index.ts", import.meta.url)
      ),
      "@zaff/events": fileURLToPath(
        new URL("./packages/events/src/index.ts", import.meta.url)
      ),
      "@zaff/storage": fileURLToPath(
        new URL("./packages/storage/src/index.ts", import.meta.url)
      ),
      "@zaff/observability": fileURLToPath(
        new URL("./packages/observability/src/index.ts", import.meta.url)
      ),
      "@zaff/auth": fileURLToPath(
        new URL("./services/auth/src/index.ts", import.meta.url)
      ),
    },
  },
  test: {
    include: [
      "packages/*/src/**/*.test.ts",
      "packages/*/test/**/*.test.ts",
      "apps/*/src/**/*.test.ts",
      "apps/*/test/**/*.test.ts",
      "services/*/src/**/*.test.ts",
      "services/*/test/**/*.test.ts",
    ],
    fileParallelism: false,
  },
});

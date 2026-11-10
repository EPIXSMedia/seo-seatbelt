import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // The command-line tests start real node processes.
    testTimeout: 20_000,
  },
});

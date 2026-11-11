import { fileURLToPath } from "node:url"
import { defineConfig, mergeConfig } from "vitest/config"
import base from "./vitest.e2e.config"

// The sandbox E2E suites against an in-process light node and L1 per file (the sdk's test/lightnode/setup.ts), so
// they need no sandbox and run side by side, one command each.
export default mergeConfig(
  base,
  defineConfig({
    test: {
      globalSetup: [
        fileURLToPath(new URL("../sdk/test/lightnode/snapshot-dir.ts", import.meta.url)),
      ],
      setupFiles: [fileURLToPath(new URL("../sdk/test/lightnode/setup.ts", import.meta.url))],
      env: { LIGHT_NODE: "1" },
    },
  }),
)

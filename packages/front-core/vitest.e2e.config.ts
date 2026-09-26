import { defineConfig } from "vitest/config"

// Sandbox e2e config — real node; each suite mutates chain state, so the scripts pin one file
// per run (`test:e2e:reorg`, `test:e2e:requests`). Not part of `pnpm test`
// (needs `aztec start --local-network`).
export default defineConfig({
  test: {
    include: ["test/e2e/**/*.e2e.ts"],
    environment: "node",
    globals: true,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    // A single leg can span a checkpoint wait, the node's ~2min reorg-detection lag
    // (REORG_DETECT_MS), and a re-confirm wait.
    testTimeout: 900_000,
    hookTimeout: 900_000,
    // Raw-JSON ESM imports inside @aztec/accounts need vite's transform (same as sdk's config).
    server: {
      deps: {
        inline: [/@aztec\/accounts/],
      },
    },
  },
})

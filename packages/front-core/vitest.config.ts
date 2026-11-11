import { defineConfig } from "vitest/config"
import path from "path"

export default defineConfig({
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
    // Suites with their own Node configs: live testnet gates (vitest.testnet.config.ts) and L1
    // tests on the in-process L1 sim (vitest.l1.config.ts).
    exclude: ["test/testnet/**", "**/*.l1.test.ts", "**/node_modules/**", "**/dist/**"],
    // Run tests sequentially to prevent React concurrent rendering issues
    pool: "forks",
    maxWorkers: 1,
    // Limit concurrency to 1 to ensure tests run sequentially
    maxConcurrency: 1,
    environmentOptions: {
      jsdom: {
        resources: "usable",
      },
    },
    // Coverage gate. Thresholds pinned to current measured baseline; bump in
    // lockstep with new tests, never lower. Target is 80/80 line+branch.
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      exclude: [
        "node_modules/",
        "test/",
        "**/*.d.ts",
        "**/*.config.ts",
        "**/*.config.js",
        "src/stories/**",
      ],
      thresholds: {
        lines: 50,
        branches: 75,
      },
    },
    deps: {
      optimizer: {
        client: {
          include: ["buffer"],
        },
      },
    },
  },
  resolve: {
    conditions: ["source"],
    alias: {
      src: path.resolve(__dirname, "./src"),
      buffer: "buffer",
      stream: "stream-browserify",
      crypto: "crypto-browserify",
    },
  },
  optimizeDeps: {
    include: ["buffer", "process"],
  },
})

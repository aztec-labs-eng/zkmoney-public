import { defineConfig } from "vitest/config"

// Coverage gate. Thresholds pinned to current measured baseline; bump in
// lockstep with new tests, never lower. Target is 80/80 line+branch.
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.d.ts",
        "src/artifacts/**", // generated codegen
      ],
      thresholds: {
        lines: 40,
        branches: 60,
      },
    },
  },
})

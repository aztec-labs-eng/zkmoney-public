import { defineConfig } from "vitest/config"

// Node by default; suites that touch the DOM opt into jsdom per file.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    setupFiles: ["./test/setup.ts"],
  },
})

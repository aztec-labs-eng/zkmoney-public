import { migrated } from "@obsidion/lint-config"

export default migrated({
  tsconfigRootDir: import.meta.dirname,
  engine: [
    "src/errors/index.ts",
    "src/cadence/index.ts",
    "src/oxide/address.ts",
    "src/oxide/holdings.ts",
  ],
  tests: ["test/**/*.mjs"],
})

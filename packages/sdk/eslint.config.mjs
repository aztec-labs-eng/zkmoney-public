import { migrated } from "@obsidion/lint-config"

export default migrated({
  tsconfigRootDir: import.meta.dirname,
  engine: ["src/oxide/escrow/skySavings.ts", "src/oxide/escrow/skyEscrowBurns.ts"],
  tests: ["test/**/*.ts"],
})

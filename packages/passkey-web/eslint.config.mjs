import { migrated } from "@obsidion/lint-config"

export default migrated({
  tsconfigRootDir: import.meta.dirname,
  debt: true,
  tests: ["test/**/*.ts"],
  copyFreeTests: true,
})

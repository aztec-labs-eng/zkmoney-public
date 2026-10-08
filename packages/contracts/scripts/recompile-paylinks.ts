/**
 * CLI for the offline paylink codegen chain: zkJWT vkey refresh → paylink compile → class-id
 * snapshot regen in @obsidion/core/constants. Run when the paylink Noir source (or the zkJWT
 * circuit) changes:
 *
 *   cd packages/contracts && pnpm recompile:paylinks
 *
 * No wallet, PXE, or on-chain transactions. The canonical contracts test runs Check D against the
 * committed verification key and both core pins.
 */

import { recompilePaylinks } from "./paylinkCodegen.js"

recompilePaylinks().catch((error) => {
  console.error("\n❌ Paylink recompilation failed:", error)
  process.exit(1)
})

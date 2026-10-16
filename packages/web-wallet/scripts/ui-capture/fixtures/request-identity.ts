import type { ChainIdentity } from "@obsidion/core/types"
import * as actual from "../../../src/ui/PxeBoot"
import { fixtureState, pause } from "./control"
import { ROLLUP } from "./data"
export * from "../../../src/ui/PxeBoot"
/** The real identity read, with only the pay page's rollup answered while a fixture is active. */
export const verifiedIdentity: typeof actual.verifiedIdentity = async (...args) => {
  if (!fixtureState()) return actual.verifiedIdentity(...args)
  if (fixtureState() === "loading") await new Promise(() => {})
  await pause(300)
  if (new URLSearchParams(location.search).get("networkFixture") === "unavailable") throw new Error("Capture network lookup is unavailable")
  return { rollupAddress: ROLLUP } as ChainIdentity
}

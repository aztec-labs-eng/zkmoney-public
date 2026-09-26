import { createNode as actual } from "@obsidion/sdk"
import { fixtureState, pause } from "./control"
import { ROLLUP } from "./data"
export * from "@obsidion/sdk"
export const createNode: typeof actual = (...args) => {
  if (!fixtureState()) return actual(...args)
  return { getL1ContractAddresses: async () => {
    if (fixtureState() === "loading") await new Promise(() => {})
    await pause(300)
    if (new URLSearchParams(location.search).get("networkFixture") === "unavailable") throw new Error("Capture network lookup is unavailable")
    return { rollupAddress: { toString: () => ROLLUP } }
  } } as unknown as ReturnType<typeof actual>
}

import { createNode as actual } from "@obsidion/sdk"
import { fixtureState, pause } from "./control"
import { ROLLUP } from "./data"
export * from "@obsidion/sdk"
/** The real node, with only the request landing's rollup lookup faked while a fixture is active. */
export const createNode: typeof actual = (...args) => {
  const node = actual(...args)
  const getL1ContractAddresses = async () => {
    if (!fixtureState()) return node.getL1ContractAddresses()
    if (fixtureState() === "loading") await new Promise(() => {})
    await pause(300)
    if (new URLSearchParams(location.search).get("networkFixture") === "unavailable") throw new Error("Capture network lookup is unavailable")
    return { rollupAddress: { toString: () => ROLLUP } } as unknown as Awaited<ReturnType<typeof node.getL1ContractAddresses>>
  }
  return new Proxy(node, {
    get: (target, prop, receiver) =>
      prop === "getL1ContractAddresses" ? getL1ContractAddresses : Reflect.get(target, prop, receiver),
  })
}

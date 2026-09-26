import * as actual from "@obsidion/front-core"
import { DEMO_L2_ADDRESS } from "../../../src/dev/demoFixtures"
import { fixtureState } from "./control"
import { TOKEN_INFO, ROLLUP } from "./data"
export * from "@obsidion/front-core"

const unavailable = () => { throw new Error("Unmocked contract operation in a UI capture") }
const opaque = new Proxy({}, { get: (_target, key) => key === "then" ? undefined : unavailable })
// The chain clock probes the tip before it reads a header, so both reads are stubbed.
const node = {
  getBlockNumber: async () => 1,
  getBlockData: async () => ({ header: { globalVariables: { blockNumber: 1, timestamp: Math.floor(Date.now() / 1000) } } }),
}
const wallet = new Proxy({ node }, { get: (target, key) => key === "node" ? target.node : key === "then" ? undefined : unavailable })
const address = { toString: () => DEMO_L2_ADDRESS }
const account = { address, getAddress: () => address }
const tokenService = {
  fetchTokenInformation: async () => (TOKEN_INFO),
}
// Only explicitly listed UI consumers receive these readiness values. WalletGate, provider setup,
// sync loops, and transaction implementations continue to consume the real contexts.
export function useAztecContext() {
  const context = actual.useAztecContext()
  return fixtureState() ? { ...context, obsidionWallet: wallet, rollupAddress: ROLLUP } as unknown as typeof context : context
}
export function useAccountContext() {
  const context = actual.useAccountContext()
  return fixtureState() ? { ...context, obsidionAccount: account } as unknown as typeof context : context
}
export function useAssetContext() {
  const context = actual.useAssetContext()
  return fixtureState() ? { ...context, tokenService, teeSigner: opaque } as unknown as typeof context : context
}
export function useContractServiceContext() {
  const context = actual.useContractServiceContext()
  return fixtureState() ? { ...context, contractService: opaque } as unknown as typeof context : context
}

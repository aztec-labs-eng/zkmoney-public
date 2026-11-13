import { describe, expect, it } from "vitest"
import { bridgeOutChains, bridgeOutDecimals } from "../../../src/features/withdraw/bridgeOutQuote"

const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
const FACTORY = `0x${"fa".repeat(20)}`
const L2_TOKEN = `0x${"0b".repeat(32)}`
const DAI_BRIDGE = "brg-dai-v6"
const chain = (chainId: number, name: string) => ({
  chainId,
  name,
  etaMinutes: 7,
  rpcUrl: "https://rpc.example",
  in: [],
  out: [
    { symbol: "USDC", address: BASE_USDC },
    { symbol: "USDT", address: `0x${"07".repeat(20)}` },
  ],
})
/** A config whose only field the reads take is its Across feature. */
const cfg = (chains = [chain(8453, "Base")]) =>
  ({
    features: {
      across: { apiUrl: "https://across.example", chains, oxide: { exit: "fea-across-v6" } },
    },
  } as never)
const exit = () => ({
  feature: {
    id: "fea-across-v6",
    project: "across",
    bridges: { dai: DAI_BRIDGE },
    contracts: { acrossBridgeEscrowFactory: FACTORY },
    variables: {},
  },
  pinnedBridges: new Set([DAI_BRIDGE]),
})
const burn = (bridgeId: string) => ({ bridgeId, l2Token: L2_TOKEN })

describe("bridgeOutChains", () => {
  it.each<[string, ReturnType<typeof exit> | undefined, number]>([
    ["lists routes for a burn its exit has an escrow for", exit(), 1],
    ["lists none without an exit", undefined, 0],
  ])("%s", (_, binding, routes) => {
    expect(bridgeOutChains(cfg(), binding, burn(DAI_BRIDGE))).toHaveLength(routes)
  })

  it("keeps the tokens oxide's Across table delivers there, and drops chains it reaches none on", () => {
    const routes = bridgeOutChains(
      cfg([chain(8453, "Base"), chain(424242, "Nowhere")]),
      exit(),
      burn(DAI_BRIDGE),
    )
    expect(routes.map((r) => [r.provider, r.l2Token, r.chain.name])).toEqual([
      ["across", L2_TOKEN, "Base"],
    ])
    expect(routes[0]!.tokens.map((t) => t.symbol)).toEqual(["USDC", "USDT"])
  })
})

describe("bridgeOutDecimals", () => {
  it.each([
    ["USDC", 8453, 6],
    ["USDC", 56, 18],
    ["USDT", 56, 18],
  ] as const)("lands %s on chain %i in %i decimals", (token, chainId, decimals) => {
    expect(bridgeOutDecimals(token, chainId)).toBe(decimals)
  })
})

import { describe, expect, it } from "vitest"
import {
  acrossEscrowFactory,
  bridgeOutChains,
  bridgeOutDecimals,
} from "../../../src/features/withdraw/bridgeOutQuote"

const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
const MANIFEST_FACTORY = `0x${"fa".repeat(20)}`
const L2_TOKEN = `0x${"0b".repeat(32)}`
const PROFILE_FACTORY = `0x${"fb".repeat(20)}`
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
/** A config whose only field the reads take is its bridge block. */
const cfg = (bridge: object) => ({ bridge } as never)
const across = (patch: object = {}) => ({
  provider: "across",
  apiUrl: "https://across.example",
  chains: [chain(8453, "Base")],
  ...patch,
})

describe("bridgeOutChains", () => {
  it("offers nothing until the manifest or the profile names the escrow factory", () => {
    const config = cfg(across())
    expect(bridgeOutChains(config, { l2Token: L2_TOKEN })).toEqual([])
    expect(bridgeOutChains(config, { acrossBridgeEscrowFactory: MANIFEST_FACTORY, l2Token: L2_TOKEN })).toHaveLength(1)
    const profile = cfg(across({ escrowFactory: PROFILE_FACTORY }))
    expect(bridgeOutChains(profile, { l2Token: L2_TOKEN })).toHaveLength(1)
  })

  it("prefers the manifest's escrow factory to the profile's", () => {
    const config = cfg(across({ escrowFactory: PROFILE_FACTORY, chains: [] }))
    expect(acrossEscrowFactory(config, { acrossBridgeEscrowFactory: MANIFEST_FACTORY })).toBe(
      MANIFEST_FACTORY,
    )
    expect(acrossEscrowFactory(config, {})).toBe(PROFILE_FACTORY)
  })

  it("keeps the profile's tokens oxide's Across table delivers there, and drops chains it reaches none on", () => {
    const config = cfg(across({ chains: [chain(8453, "Base"), chain(424242, "Nowhere")] }))
    const routes = bridgeOutChains(config, { acrossBridgeEscrowFactory: MANIFEST_FACTORY, l2Token: L2_TOKEN })
    expect(routes.map((r) => [r.provider, r.l2Token, r.chain.name])).toEqual([
      ["across", L2_TOKEN, "Base"],
    ])
    expect(routes[0]!.tokens.map((t) => t.symbol)).toEqual(["USDC", "USDT"])
  })

  it("offers no bridge-out for a provider oxide has no escrow for", () => {
    const config = cfg({
      provider: "lifi",
      apiUrl: "https://lifi.example",
      integrator: "zkmoney",
      chains: [],
    })
    expect(bridgeOutChains(config, { acrossBridgeEscrowFactory: MANIFEST_FACTORY, l2Token: L2_TOKEN })).toEqual([])
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

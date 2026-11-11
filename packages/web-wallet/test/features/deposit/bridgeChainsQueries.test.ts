/** The bridge-in's origin reads and quotes, one Query each over the page's provider and clients. */
import { describe, expect, it, vi } from "vitest"
import { zeroAddress, type Address } from "viem"
import {
  fixed,
  WalletError,
  type BridgeInProvider,
  type BridgeInQuoteRequest,
} from "@obsidion/front-core"
import { bridgeInQueries, bridgeInSource } from "../../../src/features/deposit/bridgeChains"
import { testQuery } from "../../support/query"

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address
const ACCOUNT = `0x${"a1".repeat(20)}` as Address

const client = () => ({
  chain: { nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 } },
  getBalance: vi.fn(async () => 7n),
  readContract: vi.fn(async ({ functionName }: { functionName: string }) =>
    functionName === "balanceOf" ? 5n : 0,
  ),
})

const reads = (
  over: {
    provider?: BridgeInProvider | null
    rpcToken?: () => Promise<{ symbol: string; decimals: number }>
  } = {},
) => {
  const rpc = client()
  const queries = bridgeInQueries(testQuery(), {
    client: () => rpc as never,
    origin: { token: over.rpcToken ?? (async () => ({ symbol: "RPC", decimals: 9 })) },
    provider: fixed("bridgeInProvider", over.provider ?? null),
  })
  return { rpc, ...queries }
}

describe("originBalance", () => {
  it("reads the gas token's balance, and a token's through its contract, again on every read", async () => {
    const { rpc, originBalance } = reads()
    expect(await originBalance(56, zeroAddress, ACCOUNT).read()).toBe(7n)
    expect(await originBalance(56, USDC, ACCOUNT).read()).toBe(5n)
    await originBalance(56, USDC, ACCOUNT).read()
    expect(rpc.readContract).toHaveBeenCalledTimes(2)
  })
})

describe("originToken", () => {
  it("names the chain's gas token by the chain", async () => {
    expect(await reads().originToken(56, zeroAddress).read()).toEqual({
      symbol: "BNB",
      decimals: 18,
    })
  })

  it("reads a token's decimals from its chain, and keeps them", async () => {
    const rpcToken = vi.fn(async () => ({ symbol: "RPC", decimals: 9 }))
    const { originToken } = reads({ rpcToken })
    expect(await originToken(8453, USDC).read()).toEqual({ symbol: "RPC", decimals: 9 })
    await originToken(8453, USDC).read()
    expect(rpcToken).toHaveBeenCalledOnce()
  })
})

describe("bridgeInQuote", () => {
  const request: BridgeInQuoteRequest = {
    originChainId: 8453,
    inputToken: USDC,
    destinationChainId: 1,
    outputToken: USDC,
    outputSymbol: "USDC",
    depositor: ACCOUNT,
    recipient: ACCOUNT,
    outputAmount: 1_000_000n,
  }

  it("quotes through the page's provider, and keeps its refusal as the entry's error", async () => {
    const refusal = new WalletError("bridge.belowFee", "too low")
    const quote = vi.fn<BridgeInProvider["quote"]>().mockRejectedValueOnce(refusal)
    const entry = reads({ provider: { quote, status: async () => undefined } }).bridgeInQuote(
      request,
    )
    await expect(entry.read()).rejects.toBe(refusal)
    expect(entry.get()).toMatchObject({ status: "failed", error: refusal })
  })

  it("refuses to quote where the profile names no bridge", async () => {
    await expect(reads().bridgeInQuote(request).read()).rejects.toMatchObject({
      code: "invariant",
    })
  })
})

describe("bridgeInSource", () => {
  const decimals = vi.fn(async () => 6)
  const across = {
    bridge: {
      provider: "across" as const,
      apiUrl: "https://across.example/api",
      chains: [],
    },
  }

  it("builds one Across client for quotes and deposit lookups, and none without a bridge", () => {
    const { provider, deposits } = bridgeInSource(across, decimals)
    expect(provider).toBe(deposits)
    expect(bridgeInSource({ bridge: undefined }, decimals)).toEqual({
      provider: null,
      deposits: null,
    })
  })

  it("puts a demo's bridge in place, which looks up no deposits", () => {
    const fake: BridgeInProvider = { quote: vi.fn(), status: vi.fn() }
    expect(bridgeInSource(across, decimals, fake)).toEqual({ provider: fake, deposits: null })
  })
})

/**
 * Which L1 account the app signs with. `from` is the app's own selection, and on the deposit exits
 * it is also who gets paid — so an account the wallet no longer permits has to stop the flow rather
 * than quietly become whichever account the wallet happens to list first.
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { mainnet } from "viem/chains"
import type { Config } from "wagmi"
import type { Hex } from "viem"

const CHAIN_ID = 11155111
const FIRST = `0x${"11".repeat(20)}` as Hex
const SECOND = `0x${"22".repeat(20)}` as Hex
const REVOKED = `0x${"99".repeat(20)}` as Hex

// No wagmi session: getL1Clients falls back to the injected provider.
vi.mock("wagmi/actions", () => ({ getAccount: () => ({}), switchChain: vi.fn() }))

// wagmi/actions is mocked: only the config's chains are read.
const WAGMI = { chains: [mainnet] } as unknown as Config

const { getL1Clients } = await import("../../../../src/session/l1Wallet")

/** Only the methods the injected path calls; anything else is a test bug, not a fallback. */
function injectWallet(accounts: Hex[]) {
  const request = vi.fn(async ({ method }: { method: string }) => {
    if (method === "eth_chainId") return `0x${CHAIN_ID.toString(16)}`
    if (method === "eth_requestAccounts" || method === "eth_accounts") return accounts
    throw new Error(`unexpected request: ${method}`)
  })
  window.ethereum = { request } as never
  return request
}

afterEach(() => {
  delete (window as { ethereum?: unknown }).ethereum
})

describe("getL1Clients", () => {
  it("signs with the app's selection when the wallet still permits it", async () => {
    injectWallet([FIRST, SECOND])
    expect((await getL1Clients(WAGMI, CHAIN_ID, SECOND)).account.toLowerCase()).toBe(SECOND)
  })

  it("refuses a selection the wallet has revoked instead of paying someone else", async () => {
    injectWallet([FIRST, SECOND])
    await expect(getL1Clients(WAGMI, CHAIN_ID, REVOKED)).rejects.toThrow(/no longer connected/)
  })

  it("takes the wallet's first account only when nothing was selected", async () => {
    injectWallet([FIRST, SECOND])
    expect((await getL1Clients(WAGMI, CHAIN_ID)).account.toLowerCase()).toBe(FIRST)
  })
})

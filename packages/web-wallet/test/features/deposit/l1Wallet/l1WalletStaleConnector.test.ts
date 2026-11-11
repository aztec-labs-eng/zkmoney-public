/**
 * wagmi rehydrates a persisted connection with the connector flattened to {id,name,type,uid} —
 * truthy, method-less, and reported as connected. Treating that as a wallet throws
 * "getProvider is not a function" mid-deposit, so it must read as no wallet at all.
 */
import { describe, expect, it, vi } from "vitest"
import { mainnet } from "viem/chains"
import type { Config } from "wagmi"
import type { Hex } from "viem"

const CHAIN_ID = 11155111
const ACCOUNT = `0x${"11".repeat(20)}` as Hex

const STALE = { id: "walletConnect", name: "WalletConnect", type: "walletConnect", uid: "stale" }
vi.mock("wagmi/actions", () => ({
  getAccount: () => ({ connector: STALE, chainId: CHAIN_ID, addresses: [ACCOUNT] }),
  switchChain: vi.fn(),
}))

// wagmi/actions is mocked: only the config's chains are read.
const WAGMI = { chains: [mainnet] } as unknown as Config

const { getL1Clients } = await import("../../../../src/session/l1Wallet")

describe("getL1Clients with a storage-rehydrated connector", () => {
  it("ignores the stub and prompts the injected wallet instead of throwing", async () => {
    const request = vi.fn(async ({ method }: { method: string }) => {
      if (method === "eth_chainId") return `0x${CHAIN_ID.toString(16)}`
      if (method === "eth_requestAccounts") return [ACCOUNT]
      throw new Error(`unexpected request: ${method}`)
    })
    window.ethereum = { request } as never
    expect((await getL1Clients(WAGMI, CHAIN_ID)).account.toLowerCase()).toBe(ACCOUNT)
    delete (window as { ethereum?: unknown }).ethereum
  })

  it("reports no wallet rather than a TypeError when nothing else is injected", async () => {
    await expect(getL1Clients(WAGMI, CHAIN_ID)).rejects.toThrow(/No wallet connected/)
  })
})

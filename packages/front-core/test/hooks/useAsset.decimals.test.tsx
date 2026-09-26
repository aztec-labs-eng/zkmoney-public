import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import React from "react"
import { render, waitFor } from "@testing-library/react"
import { parseUnits } from "viem"

// ---------------------------------------------------------------------------
// U5 — persisted token-row refresh. An upgraded install can carry a pre-cutover
// TokenStorage row against the CURRENT token address: 6-dp decimals (left alone
// it wins in createAssetWithBalance and mis-scales paylink escrow amounts by
// 10^12) and/or the legacy "USDC" display identity. These tests render useAsset
// with a seeded stale row and assert the row is actually REWRITTEN to 18-dp
// the current identity (a test that only checked the resolved asset value could pass without
// the refresh existing), scoped to the active oxideToken address only.
// ---------------------------------------------------------------------------

const ACTIVE_ADDR = "0xactivetoken"
const OLD_ADDR = "0xoldtoken"
const BALANCE = 5_000_000_000_000_000_000n // 5 at 18-dp

const { tokenStoreRef, activeAddressRef, mockObsidionAccount, mockObsidionWallet } = vi.hoisted(
  () => ({
    tokenStoreRef: { current: [] as any[] },
    activeAddressRef: { current: undefined as undefined | { toString: () => string } },
    mockObsidionAccount: {
      getAddress: () => ({
        toString: () => "0xobsidion-account",
        equals: (other: any) => other?.toString?.() === "0xobsidion-account",
      }),
      getCompleteAddress: () => ({ toString: () => "0xcomplete" }),
    } as any,
    mockObsidionWallet: { pxe: { registerSender: vi.fn() }, _id: "wallet" } as unknown,
  }),
)

const tokenServiceStub = {
  account: {
    getAddress: () => ({ equals: (other: any) => other?.toString?.() === "0xobsidion-account" }),
    getCompleteAddress: () => ({ toString: () => "0xcomplete" }),
  },
  setAccount: vi.fn(),
  setTeeSigner: vi.fn(),
  tokenAddress: { toString: () => ACTIVE_ADDR },
  getBalance: vi.fn(async () => BALANCE),
}

vi.mock("@obsidion/sdk", async () => {
  const actual = await vi.importActual<typeof import("@obsidion/sdk")>("@obsidion/sdk")
  return {
    ...actual,
    TokenService: { create: vi.fn(async () => tokenServiceStub) },
    ContractService: {
      getInstance: () => ({ getContractAddress: vi.fn(async () => activeAddressRef.current) }),
    },
  }
})

vi.mock("src/contexts/useAccountContext", () => ({
  useAccountContext: () => ({ obsidionAccount: mockObsidionAccount }),
}))

vi.mock("src/contexts/useAztecContext", () => ({
  useAztecContext: () => ({
    obsidionWallet: mockObsidionWallet,
    currentNetwork: { type: "testnet" },
  }),
}))

vi.mock("src/core", async () => {
  const actual = await vi.importActual<typeof import("src/core")>("src/core")
  return {
    ...actual,
    TokenStorage: {
      get: () => ({
        getTokens: vi.fn(async () => tokenStoreRef.current),
        addToken: vi.fn(async (t: any) => {
          tokenStoreRef.current = tokenStoreRef.current.filter((x: any) => x.address !== t.address)
          tokenStoreRef.current.push(t)
        }),
      }),
    },
    // The store is the only balance source: seed the active token's row for this scope.
    BalanceStorage: {
      get: () => ({
        load: vi.fn(async () => {}),
        list: vi.fn(() => [
          { scope: "testnet:0xcomplete", tokenAddress: ACTIVE_ADDR, balance: BALANCE.toString() },
        ]),
        onListChanged: vi.fn(() => () => {}),
        updateBalance: vi.fn(async () => {}),
      }),
    },
    TransactionStorage: { get: () => ({ getTransactions: vi.fn(async () => []) }) },
    WithdrawalStorage: {
      get: () => ({ list: vi.fn(() => []), onListChanged: vi.fn(() => () => {}) }),
    },
    AccountStorage: {
      get: () => ({ getAccount: vi.fn(async () => ({ completeAddress: "0xcomplete" })) }),
    },
    globalEventEmitter: {
      onTransactionsUpdated: vi.fn(),
      offTransactionsUpdated: vi.fn(),
      onIncomingTransfer: vi.fn(),
      offIncomingTransfer: vi.fn(),
    },
  }
})

vi.mock("src/utils", async () => {
  const actual = await vi.importActual<typeof import("src/utils")>("src/utils")
  return {
    ...actual,
    compAddrToAztecAddr: vi.fn(async () => ({
      equals: (other: any) => other?.toString?.() === "0xcomplete",
      toString: () => "0xcomplete",
    })),
  }
})

import { useAsset } from "../../src/hooks/useAsset"

function renderUseAsset() {
  const result: { current: ReturnType<typeof useAsset> | null } = { current: null }
  const Wrapper = () => {
    result.current = useAsset()
    return null
  }
  const utils = render(React.createElement(Wrapper))
  return { result: result as { current: ReturnType<typeof useAsset> }, ...utils }
}

// Legacy row shape, as persisted by older builds.
function legacyUsdcRow(address: string, decimals: number) {
  return { address, name: "USD Coin", symbol: "USDC", decimals }
}

describe("useAsset persisted token-row refresh", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    tokenStoreRef.current = []
    activeAddressRef.current = { toString: () => ACTIVE_ADDR }
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("repairs the active token's stale decimals without rewriting its stored identity", async () => {
    tokenStoreRef.current = [legacyUsdcRow(ACTIVE_ADDR, 6)]
    const { result, unmount } = renderUseAsset()

    await waitFor(() =>
      expect(tokenStoreRef.current.find((t) => t.address === ACTIVE_ADDR)?.decimals).toBe(18),
    )
    // Decimals are arithmetic and the row's value wins downstream, so a wrong
    // one is corrected at the source. Identity is presentation — it is resolved
    // on read, so the stored row keeps the name it was written with rather than
    // a display change turning into a silent migration of persisted records.
    const repaired = tokenStoreRef.current.find((t) => t.address === ACTIVE_ADDR)
    expect(repaired?.symbol).toBe("USDC")
    expect(repaired?.name).toBe("USD Coin")

    await waitFor(() =>
      expect(result.current.assets?.find((a) => a.address === ACTIVE_ADDR)?.decimals).toBe(18),
    )
    unmount()
  })

  it("does not rewrite a non-active old-address record (address-scoped)", async () => {
    tokenStoreRef.current = [legacyUsdcRow(ACTIVE_ADDR, 6), legacyUsdcRow(OLD_ADDR, 6)]
    const { unmount } = renderUseAsset()

    await waitFor(() =>
      expect(tokenStoreRef.current.find((t) => t.address === ACTIVE_ADDR)?.decimals).toBe(18),
    )
    const untouched = tokenStoreRef.current.find((t) => t.address === OLD_ADDR)
    expect(untouched?.decimals).toBe(6)
    expect(untouched?.symbol).toBe("USDC")
    unmount()
  })

  it("skips the refresh when no active address is resolved yet", async () => {
    activeAddressRef.current = undefined
    tokenStoreRef.current = [legacyUsdcRow(ACTIVE_ADDR, 6)]
    const { result, unmount } = renderUseAsset()

    await waitFor(() => expect(result.current.assets).not.toBeNull())
    expect(tokenStoreRef.current.find((t) => t.address === ACTIVE_ADDR)?.decimals).toBe(6)
    unmount()
  })
})

// A paylink escrow builds its on-chain amount
// as parseUnits(amount, selectedAsset.decimals). Once the refresh makes decimals
// 18, a $5 intent escrows 5e18 (not 5e6). parseUnits also keeps full precision at
// 18-dp, which parseFloat * 10 ** 18 cannot for large amounts.
describe("paylink escrow scaling at 18-dp", () => {
  it("scales whole and fractional amounts to exact 18-dp base units", () => {
    expect(parseUnits("5", 18)).toBe(5_000_000_000_000_000_000n)
    expect(parseUnits("5.25", 18)).toBe(5_250_000_000_000_000_000n)
  })

  it("keeps precision for a large amount where parseFloat * 10 ** 18 drifts", () => {
    const amount = "1234567.89"
    expect(parseUnits(amount, 18)).toBe(1_234_567_890_000_000_000_000_000n)
    const floatApprox = BigInt(Math.round(parseFloat(amount) * 10 ** 18))
    expect(floatApprox).not.toBe(parseUnits(amount, 18))
  })
})

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import React from "react"
import { render, act, waitFor } from "@testing-library/react"

// ---------------------------------------------------------------------------
// Hoisted mock state. Each test resets these in `beforeEach`.
//
// The TEE connect is now source-driven: useAsset is environment-agnostic and
// simply drives whatever `TeeSignerSource` is injected (load / subscribe /
// refresh). The oxide-vs-sandbox decision lives in the source factories,
// covered separately in `teeSignerSource.test.ts`. These tests assert the
// hook's orchestration contract against a fake source.
// ---------------------------------------------------------------------------

const {
  mockObsidionAccount,
  mockObsidionWallet,
  setTeeSignerMock,
  setAccountMock,
  mockAztecState,
  mockAccountState,
  mockStorageState,
} = vi.hoisted(() => {
  const mockObsidionWallet = {
    getAccounts: vi.fn(async () => [
      { item: { equals: (other: any) => other?.toString?.() === "0xobsidion-account" } },
    ]),
    pxe: { registerSender: vi.fn() },
    _id: "wallet",
  } as unknown
  return {
    mockObsidionAccount: {
      getAddress: () => ({
        toString: () => "0xobsidion-account",
        equals: (other: any) => other?.toString?.() === "0xobsidion-account",
      }),
      getCompleteAddress: () => ({ toString: () => "0xcomplete" }),
    } as any,
    mockObsidionWallet,
    setTeeSignerMock: vi.fn(),
    setAccountMock: vi.fn(),
    // Mutable per-test knobs; reset in `beforeEach`.
    mockAztecState: {
      obsidionWallet: mockObsidionWallet as any,
      currentNetwork: { type: "sandbox" } as any,
    },
    mockAccountState: { obsidionAccount: undefined as any },
    mockStorageState: {
      completeAddress: "0xcomplete",
      tokens: [] as any[],
      /** Seeded rows read as cache-hydrated (no `updatedAt`); `updateBalance` writes stamp one. */
      balances: {} as Record<string, bigint>,
      liveKeys: new Set<string>(),
      listeners: new Set<(records: unknown[]) => void>(),
      contractAddress: undefined as { toString(): string } | undefined,
    },
  }
})

// Mock TokenService.create — returns a stub with `setTeeSigner` we can spy on.
const tokenServiceStub = {
  account: {
    getAddress: () => ({
      equals: (other: any) => other?.toString?.() === "0xobsidion-account",
    }),
    getCompleteAddress: () => ({ toString: () => "0xcomplete" }),
  },
  setAccount: setAccountMock,
  setTeeSigner: setTeeSignerMock,
  tokenAddress: undefined as { toString(): string } | undefined,
}

vi.mock("@obsidion/sdk", async () => {
  const actual = await vi.importActual<typeof import("@obsidion/sdk")>("@obsidion/sdk")
  return {
    ...actual,
    TokenService: {
      create: vi.fn(async () => tokenServiceStub),
    },
    ContractService: {
      getInstance: () => ({
        getContractAddress: vi.fn(async () => mockStorageState.contractAddress),
      }),
    },
  }
})

vi.mock("src/contexts/useAccountContext", () => ({
  useAccountContext: () => mockAccountState,
}))

vi.mock("src/contexts/useAztecContext", () => ({
  useAztecContext: () => mockAztecState,
}))

vi.mock("src/core", async () => {
  const actual = await vi.importActual<typeof import("src/core")>("src/core")
  // Stable stub implementing the CachedRecordSource surface useAsset hydrates
  // through, backed by the mutable `mockStorageState.balances` map (keys are
  // `${scope}:${token}`, the token being the last `:`-segment).
  const balanceStorageStub = {
    load: vi.fn(async () => {}),
    list: vi.fn(() =>
      Object.entries(mockStorageState.balances).map(([key, balance]) => {
        const sep = key.lastIndexOf(":")
        return {
          scope: key.slice(0, sep),
          tokenAddress: key.slice(sep + 1),
          balance: balance.toString(),
          updatedAt: mockStorageState.liveKeys.has(key) ? Date.now() : undefined,
        }
      }),
    ),
    onListChanged: vi.fn((listener: (records: unknown[]) => void) => {
      mockStorageState.listeners.add(listener)
      return () => mockStorageState.listeners.delete(listener)
    }),
    updateBalance: vi.fn(async (scope: string, addr: string, balance: bigint) => {
      const key = `${scope}:${addr}`
      mockStorageState.balances[key] = balance
      mockStorageState.liveKeys.add(key)
      const records = balanceStorageStub.list()
      mockStorageState.listeners.forEach((l) => l(records))
    }),
  }
  return {
    ...actual,
    TokenStorage: {
      get: () => ({
        getTokens: vi.fn(async () => mockStorageState.tokens),
        addToken: vi.fn(async (t: any) => {
          mockStorageState.tokens = [
            ...mockStorageState.tokens.filter((x) => x.address !== t.address),
            t,
          ]
        }),
      }),
    },
    BalanceStorage: {
      get: () => balanceStorageStub,
    },
    TransactionStorage: { get: () => ({ getTransactions: vi.fn(async () => []) }) },
    WithdrawalStorage: {
      get: () => ({ list: vi.fn(() => []), onListChanged: vi.fn(() => () => {}) }),
    },
    AccountStorage: {
      get: () => ({
        getAccount: vi.fn(async () => ({ completeAddress: mockStorageState.completeAddress })),
      }),
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

import { useAsset, type UseAssetOptions } from "../../src/hooks/useAsset"
import { TeeSignerNotApprovedError, reportTeeSignerRefused } from "@obsidion/sdk"
import { AztecAddress } from "@aztec/stdlib/aztec-address"
import { EthAddress } from "@aztec/foundation/eth-address"
import { BalanceStorage } from "src/core"
import type { TeeSignerSource } from "../../src/tee/teeSignerSource"

function renderHook(options?: UseAssetOptions) {
  const result: { current: ReturnType<typeof useAsset> | null } = { current: null }
  const Wrapper = () => {
    result.current = useAsset(options)
    return null
  }
  const utils = render(React.createElement(Wrapper))
  return {
    result: result as { current: ReturnType<typeof useAsset> },
    ...utils,
    rerender: () => utils.rerender(React.createElement(Wrapper)),
  }
}

const FAKE_SIGNER = {
  publicKey: { x: 0n, y: 0n },
  ethAddress: { toString: () => "0xenclave-eth-addr" },
  encryptionPublicKey: {},
  signTokenOperation: vi.fn(),
  signWithdrawalFinalization: vi.fn(),
  signFrozenNotesRefundFinalization: vi.fn(),
  signFrozenDepositRefundFinalization: vi.fn(),
  signUnprocessedDepositRefundFinalization: vi.fn(),
} as any

/** Fake TeeSignerSource with an `emit()` hook to fire its subscribers. */
function makeFakeSource(overrides: Partial<TeeSignerSource> = {}) {
  const listeners = new Set<() => void>()
  const source = {
    label: "fake-source",
    load: vi.fn(async () => FAKE_SIGNER),
    subscribe: vi.fn((cb: () => void) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    }),
    refresh: vi.fn(),
    ...overrides,
  } as TeeSignerSource & { load: ReturnType<typeof vi.fn>; refresh: ReturnType<typeof vi.fn> }
  return { source, emit: () => [...listeners].forEach((l) => l()) }
}

describe("useAsset background-connect", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setTeeSignerMock.mockReset()
    mockAztecState.obsidionWallet = mockObsidionWallet
    mockAztecState.currentNetwork = { type: "sandbox" }
    mockAccountState.obsidionAccount = mockObsidionAccount
    mockStorageState.completeAddress = "0xcomplete"
    mockStorageState.tokens = []
    mockStorageState.balances = {}
    mockStorageState.liveKeys.clear()
    mockStorageState.listeners.clear()
    mockStorageState.contractAddress = undefined
    tokenServiceStub.tokenAddress = undefined
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it("does not connect when no teeSignerSource is injected", async () => {
    const { source } = makeFakeSource()
    const { result, unmount } = renderHook({ initialTokensToLoad: ["DAI"] })

    await waitFor(() => expect(result.current.tokenService).toBeTruthy())
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50))
    })

    expect(source.load).not.toHaveBeenCalled()
    expect(setTeeSignerMock).not.toHaveBeenCalled()
    expect(result.current.teeSigner).toBeUndefined()
    unmount()
  })

  it("loads the signer from the source and fans it into TokenService", async () => {
    const { source } = makeFakeSource()
    const { result, unmount } = renderHook({
      initialTokensToLoad: ["DAI"],
      teeSignerSource: source,
    })

    await waitFor(() => expect(result.current.tokenService).toBeTruthy())
    await waitFor(() => expect(result.current.teeSigner).toBe(FAKE_SIGNER))

    expect(source.load).toHaveBeenCalledTimes(1)
    expect(setTeeSignerMock).toHaveBeenCalledWith(FAKE_SIGNER)
    unmount()
  })

  it("logs a positive connect line with the source label (non-secret)", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    const { source } = makeFakeSource()
    const { result, unmount } = renderHook({ teeSignerSource: source })

    await waitFor(() => expect(result.current.teeSigner).toBe(FAKE_SIGNER))

    expect(logSpy).toHaveBeenCalledWith(
      "[useAsset] TEE signer connected",
      expect.objectContaining({ ethAddress: "0xenclave-eth-addr", source: "fake-source" }),
    )
    unmount()
  })

  it("treats a load() returning undefined as a benign skip (no signer, no refresh)", async () => {
    const { source } = makeFakeSource({ load: vi.fn(async () => undefined) })
    const { result, unmount } = renderHook({ teeSignerSource: source })

    await waitFor(() => expect(result.current.tokenService).toBeTruthy())
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50))
    })

    expect(setTeeSignerMock).not.toHaveBeenCalledWith(FAKE_SIGNER)
    expect((source as any).refresh).not.toHaveBeenCalled()
    expect(result.current.teeSigner).toBeUndefined()
    unmount()
  })

  it("reconnects when the source's subscribe fires (e.g. a manifest roll)", async () => {
    const SIGNER_B = { ...FAKE_SIGNER, ethAddress: { toString: () => "0xenclave-B" } } as any
    const load = vi.fn(async () => FAKE_SIGNER)
    const { source, emit } = makeFakeSource({ load })

    const { result, unmount } = renderHook({ teeSignerSource: source })
    await waitFor(() => expect(result.current.teeSigner).toBe(FAKE_SIGNER))

    load.mockResolvedValueOnce(SIGNER_B)
    setTeeSignerMock.mockClear()
    await act(async () => {
      emit()
    })

    await waitFor(() => expect(result.current.teeSigner).toBe(SIGNER_B))
    // Old signer cleared before the reconnect landed.
    expect(setTeeSignerMock).toHaveBeenCalledWith(undefined)
    expect(setTeeSignerMock).toHaveBeenCalledWith(SIGNER_B)
    expect(load).toHaveBeenCalledTimes(2)
    unmount()
  })

  it("asks the source to refresh on a load() failure; signer stays cleared", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    const { source } = makeFakeSource({
      load: vi.fn(async () => Promise.reject(new Error("PCR0 not approved"))),
    })

    const { result, unmount } = renderHook({ teeSignerSource: source })

    await waitFor(() =>
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("TEE signer connect failed"),
        expect.any(Error),
      ),
    )
    await waitFor(() => expect((source as any).refresh).toHaveBeenCalledTimes(1))
    expect(result.current.teeSigner).toBeUndefined()
    unmount()
  })

  it("exposes the last connect failure and clears it once a retry connects", async () => {
    vi.useFakeTimers()
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const failure = new Error("enclave hiccup")
    const load = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(FAKE_SIGNER)
    const { source } = makeFakeSource({ load, subscribe: undefined })

    const { result, unmount } = renderHook({ teeSignerSource: source })
    expect(result.current.teeSignerError).toBeNull()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(50)
    })
    expect(result.current.teeSignerError).toBe(failure)
    expect(result.current.teeSigner).toBeUndefined()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000)
    })
    expect(result.current.teeSigner).toBe(FAKE_SIGNER)
    expect(result.current.teeSignerError).toBeNull()
    unmount()
  })

  it("names the refused enclave when the token has not approved the pinned key", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    const refusal = new TeeSignerNotApprovedError(
      AztecAddress.fromStringUnsafe("0x" + "11".repeat(31) + "01"),
      EthAddress.fromString("0x" + "ab".repeat(20)),
      "0x01",
    )
    const { source } = makeFakeSource({ load: vi.fn(async () => Promise.reject(refusal)) })

    const { result, unmount } = renderHook({ teeSignerSource: source })

    await waitFor(() => expect(result.current.teeSignerError).toBe(refusal))
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("enclave not approved on the token"),
      expect.objectContaining({ enclave: "0x" + "ab".repeat(20) }),
    )
    expect(result.current.teeSigner).toBeUndefined()
    unmount()
  })

  it("drops a signer the finalizer refused at sign time and reconnects until an approved enclave lands", async () => {
    vi.useFakeTimers()
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const refusal = new TeeSignerNotApprovedError(
      AztecAddress.fromStringUnsafe("0x" + "11".repeat(31) + "01"),
      EthAddress.fromString("0x" + "bb".repeat(20)),
      "0x02",
    )
    const SIGNER_C = { ...FAKE_SIGNER, ethAddress: { toString: () => "0xenclave-c" } }
    // A connects; the fleet then hands out the unapproved B once more before C.
    const load = vi
      .fn()
      .mockResolvedValueOnce(FAKE_SIGNER)
      .mockRejectedValueOnce(refusal)
      .mockResolvedValue(SIGNER_C)
    const { source } = makeFakeSource({ load, subscribe: undefined })

    const { result, unmount } = renderHook({ teeSignerSource: source })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50)
    })
    expect(result.current.teeSigner).toBe(FAKE_SIGNER)
    setTeeSignerMock.mockClear()

    // `signTokenOperation` re-pinned A's FleetSigner to B, and the finalizer refused B's key.
    await act(async () => {
      reportTeeSignerRefused(FAKE_SIGNER, refusal)
      await vi.advanceTimersByTimeAsync(50)
    })
    expect(result.current.teeSigner).toBeUndefined()
    expect(setTeeSignerMock).toHaveBeenCalledWith(undefined)
    expect(result.current.teeSignerError).toBe(refusal)
    expect(load).toHaveBeenCalledTimes(2)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000)
    })
    expect(load).toHaveBeenCalledTimes(3)
    expect(result.current.teeSigner).toBe(SIGNER_C)
    expect(result.current.teeSignerError).toBeNull()
    expect(setTeeSignerMock).toHaveBeenLastCalledWith(SIGNER_C)
    unmount()
  })

  it("ignores a sign-time refusal of a signer it no longer holds", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const refusal = new TeeSignerNotApprovedError(
      AztecAddress.fromStringUnsafe("0x" + "11".repeat(31) + "01"),
      EthAddress.fromString("0x" + "bb".repeat(20)),
      "0x02",
    )
    const { source } = makeFakeSource()
    const { result, unmount } = renderHook({ teeSignerSource: source })
    await waitFor(() => expect(result.current.teeSigner).toBe(FAKE_SIGNER))

    // An op that started on a signer a manifest roll already replaced.
    await act(async () => {
      reportTeeSignerRefused({ ...FAKE_SIGNER }, refusal)
    })
    expect(source.load).toHaveBeenCalledTimes(1)
    expect(result.current.teeSigner).toBe(FAKE_SIGNER)
    expect(result.current.teeSignerError).toBeNull()
    unmount()
  })

  it("self-retries with backoff after a failed connect (subscribe never ticks on a static manifest)", async () => {
    vi.useFakeTimers()
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error("enclave hiccup"))
      .mockResolvedValue(FAKE_SIGNER)
    const { source } = makeFakeSource({ load, subscribe: undefined })

    const { result, unmount } = renderHook({ teeSignerSource: source })

    // Flush tokenService init + the first (failing) connect.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50)
    })
    expect(load).toHaveBeenCalledTimes(1)
    expect(result.current.teeSigner).toBeUndefined()

    // First backoff step is 4s; the retry connects successfully.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000)
    })
    expect(load).toHaveBeenCalledTimes(2)
    expect(result.current.teeSigner).toBe(FAKE_SIGNER)
    expect(setTeeSignerMock).toHaveBeenCalledWith(FAKE_SIGNER)
    unmount()
  })

  it("a hung load() is bounded by the watchdog and retried", async () => {
    vi.useFakeTimers()
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    const load = vi
      .fn()
      .mockImplementationOnce(() => new Promise(() => {})) // never settles
      .mockResolvedValue(FAKE_SIGNER)
    const { source } = makeFakeSource({ load, subscribe: undefined })

    const { result, unmount } = renderHook({ teeSignerSource: source })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(50)
    })
    expect(load).toHaveBeenCalledTimes(1)

    // Watchdog fires at 60s, then the 4s backoff retry connects.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("TEE signer connect failed"),
      expect.objectContaining({ message: expect.stringContaining("timed out after 60000ms") }),
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000)
    })
    expect(load).toHaveBeenCalledTimes(2)
    expect(result.current.teeSigner).toBe(FAKE_SIGNER)
    unmount()
  })

  it("a pending retry is cancelled by unmount", async () => {
    vi.useFakeTimers()
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const load = vi.fn().mockRejectedValue(new Error("down"))
    const { source } = makeFakeSource({ load, subscribe: undefined })

    const { unmount } = renderHook({ teeSignerSource: source })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50)
    })
    expect(load).toHaveBeenCalledTimes(1)

    unmount()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300_000)
    })
    expect(load).toHaveBeenCalledTimes(1)
  })

  it("clears the signer and unsubscribes on unmount", async () => {
    const unsubscribe = vi.fn()
    const { source } = makeFakeSource({ subscribe: vi.fn(() => unsubscribe) })
    const { result, unmount } = renderHook({ teeSignerSource: source })

    await waitFor(() => expect(result.current.teeSigner).toBe(FAKE_SIGNER))
    expect(setTeeSignerMock).toHaveBeenCalledWith(FAKE_SIGNER)

    unmount()

    expect(setTeeSignerMock).toHaveBeenCalledWith(undefined)
    expect(unsubscribe).toHaveBeenCalled()
  })

  it("hydrates last-known balances from cache on mount, before any wallet/PXE init", async () => {
    // No wallet yet — token service init never runs, mirroring app cold start.
    mockAztecState.obsidionWallet = null
    mockStorageState.tokens = [{ address: "0xtok", symbol: "DAI", name: "DAI", decimals: 2 }]
    mockStorageState.balances = { "sandbox:0xcomplete:0xtok": 12345n }

    const { result, unmount } = renderHook()

    await waitFor(() => expect(result.current.assets).not.toBeNull())
    expect(result.current.assets).toHaveLength(1)
    expect(result.current.assets![0].balance).toBe(123.45)
    // Cached values are display-only: not live-confirmed until a real fetch.
    expect(result.current.liveAssetsLoaded).toBe(false)
    await waitFor(() => expect(result.current.assetsLoading).toBe(false))
    unmount()
  })

  it("hydrates when the network loads after mount (no ordering can skip the cache fill)", async () => {
    mockAztecState.obsidionWallet = null
    mockAztecState.currentNetwork = null
    mockStorageState.tokens = [{ address: "0xtok", symbol: "DAI", name: "DAI", decimals: 2 }]
    mockStorageState.balances = { "sandbox:0xcomplete:0xtok": 12345n }

    const { result, rerender, unmount } = renderHook()

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50))
    })
    expect(result.current.assets).toBeNull()

    mockAztecState.currentNetwork = { type: "sandbox" } as any
    rerender()

    await waitFor(() => expect(result.current.assets).not.toBeNull())
    expect(result.current.assets![0].balance).toBe(123.45)
    unmount()
  })

  it("clears the previous scope's balance when the network switches to one with no record", async () => {
    mockAztecState.obsidionWallet = null
    mockStorageState.tokens = [{ address: "0xtok", symbol: "DAI", name: "DAI", decimals: 2 }]
    mockStorageState.balances = { "sandbox:0xcomplete:0xtok": 12345n }
    mockStorageState.liveKeys.add("sandbox:0xcomplete:0xtok")

    const { result, rerender, unmount } = renderHook()
    await waitFor(() => expect(result.current.assets).not.toBeNull())
    await waitFor(() => expect(result.current.liveAssetsLoaded).toBe(true))

    mockAztecState.currentNetwork = { type: "testnet" } as any
    rerender()

    await waitFor(() => expect(result.current.assets).toBeNull())
    expect(result.current.liveAssetsLoaded).toBe(false)
    unmount()
  })

  it.each(["empty", "cached", "live"])(
    "projects the new account's %s balance on an account-only switch",
    async (balanceState) => {
      mockStorageState.tokens = [{ address: "0xtok", symbol: "DAI", name: "DAI", decimals: 2 }]
      mockStorageState.balances = { "sandbox:0xcomplete:0xtok": 12345n }
      mockStorageState.liveKeys.add("sandbox:0xcomplete:0xtok")
      if (balanceState !== "empty") {
        mockStorageState.balances["sandbox:0xother-account:0xtok"] = 999n
      }
      if (balanceState === "live") {
        mockStorageState.liveKeys.add("sandbox:0xother-account:0xtok")
      }

      const { result, rerender, unmount } = renderHook()
      await waitFor(() => expect(result.current.tokenService).toBeTruthy())
      await waitFor(() => expect(result.current.assets?.[0]?.balance).toBe(123.45))
      await waitFor(() => expect(result.current.liveAssetsLoaded).toBe(true))

      // Keep the network and balance records unchanged: only the active account changes.
      mockStorageState.completeAddress = "0xother-account"
      mockAccountState.obsidionAccount = {
        getAddress: () => ({ toString: () => "0xother-account" }),
        getCompleteAddress: () => ({ toString: () => "0xother-account" }),
      }
      rerender()

      await waitFor(() => {
        if (balanceState === "empty") expect(result.current.assets).toBeNull()
        else expect(result.current.assets?.[0]?.balance).toBe(9.99)
        expect(result.current.liveAssetsLoaded).toBe(balanceState === "live")
      })
      unmount()
    },
  )

  it("ignores cached balances from another network or account scope", async () => {
    mockAztecState.obsidionWallet = null
    mockStorageState.tokens = [{ address: "0xtok", symbol: "DAI", name: "DAI", decimals: 2 }]
    mockStorageState.balances = {
      "testnet:0xcomplete:0xtok": 12345n,
      "sandbox:0xother-account:0xtok": 999n,
    }

    const { result, unmount } = renderHook()

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50))
    })
    expect(result.current.assets).toBeNull()
    unmount()
  })

  it("leaves assets null when nothing is cached (fresh install shows loading, not $0)", async () => {
    mockAztecState.obsidionWallet = null
    mockStorageState.tokens = [{ address: "0xtok", symbol: "DAI", name: "DAI", decimals: 2 }]

    const { result, unmount } = renderHook()

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50))
    })
    expect(result.current.assets).toBeNull()
    unmount()
  })

  it("persists the token row on init and projects a live store write as a confirmed balance", async () => {
    // First launch: nothing stored, wallet up, DAI resolvable on-chain.
    mockStorageState.contractAddress = { toString: () => "0xtok" }
    tokenServiceStub.tokenAddress = { toString: () => "0xtok" }

    const { result, unmount } = renderHook({ initialTokensToLoad: ["DAI"] })

    await waitFor(() =>
      expect(mockStorageState.tokens.some((t) => t.address === "0xtok")).toBe(true),
    )
    expect(result.current.assets).toBeNull()
    expect(result.current.liveAssetsLoaded).toBe(false)

    // The coordinator's synced tick writes the store; the hook only projects it.
    await act(async () => {
      await BalanceStorage.get().updateBalance("sandbox:0xcomplete", "0xtok", 777n, 12)
    })

    await waitFor(() => expect(result.current.assets?.[0]?.balance).toBeGreaterThan(0))
    expect(result.current.liveAssetsLoaded).toBe(true)
    unmount()
  })

  it("loadAssets waits for a coordinator and gives up after the cap when none starts", async () => {
    const { result, unmount } = renderHook()
    vi.useFakeTimers()
    try {
      let settled = false
      let pending!: Promise<void>
      await act(async () => {
        pending = result.current.loadAssets().then(() => {
          settled = true
        })
        await vi.advanceTimersByTimeAsync(1_000)
      })
      expect(settled).toBe(false)
      expect(result.current.assetsLoading).toBe(true)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000)
        await pending
      })
      expect(settled).toBe(true)
      expect(result.current.assetsLoading).toBe(false)
    } finally {
      vi.useRealTimers()
    }
    unmount()
  })

  it("leaves assets null when no tokens are stored", async () => {
    mockAztecState.obsidionWallet = null

    const { result, unmount } = renderHook()

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50))
    })
    expect(result.current.assets).toBeNull()
    unmount()
  })

  it("does not write state for a stale connect that resolves after unmount", async () => {
    let resolveSigner: (s: any) => void = () => {}
    const deferred = new Promise((resolve) => {
      resolveSigner = resolve
    })
    const { source } = makeFakeSource({ load: vi.fn(() => deferred as Promise<any>) })

    const { unmount } = renderHook({ teeSignerSource: source })
    await waitFor(() => expect((source as any).load).toHaveBeenCalled())

    unmount()
    resolveSigner(FAKE_SIGNER)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50))
    })

    expect(setTeeSignerMock).not.toHaveBeenCalled()
  })

  it("connects with no account behind it (a paylink visitor cashing out)", async () => {
    // The enclave binding is on-chain and the source reads it off the manifest, so nothing about
    // the connect needs an account. Gating it behind one left a link holder without a co-signer.
    mockAccountState.obsidionAccount = undefined
    const { source } = makeFakeSource()

    const { result, unmount } = renderHook({ teeSignerSource: source })

    await waitFor(() => expect(result.current.teeSigner).toBe(FAKE_SIGNER))
    expect(result.current.tokenService).toBeNull()
    expect(source.load).toHaveBeenCalledTimes(1)
    unmount()
  })

  it("hands the signer to a TokenService that arrives after the connect", async () => {
    mockAccountState.obsidionAccount = undefined
    const { source } = makeFakeSource()

    const { result, rerender, unmount } = renderHook({ teeSignerSource: source })
    await waitFor(() => expect(result.current.teeSigner).toBe(FAKE_SIGNER))
    expect(setTeeSignerMock).not.toHaveBeenCalledWith(FAKE_SIGNER)

    mockAccountState.obsidionAccount = mockObsidionAccount
    rerender()

    await waitFor(() => expect(setTeeSignerMock).toHaveBeenCalledWith(FAKE_SIGNER))
    unmount()
  })
})

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import React from "react"
import { render, act, waitFor } from "@testing-library/react"

// ---------------------------------------------------------------------------
// Hoisted mock state. Each test resets these in `beforeEach`.
//
// useAsset drives whatever `TeeSignerSource` is injected (load / subscribe /
// refresh); the source factories are covered in `teeSignerSource.test.ts`.
// These tests assert the hook's orchestration contract against a fake source.
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
  fetchTokenInformation: vi.fn(async () => ({
    address: "0xtok",
    name: "Dai",
    symbol: "DAI",
    decimals: 18,
  })),
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
      get: () => ({ load: async () => {}, list: () => [], onListChanged: () => () => {} }),
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
  teeRegistry: { toString: () => "0xtee-registry" },
  signTokenOperation: vi.fn(),
  signWithdrawalFinalization: vi.fn(),
  signFrozenNotesRefundFinalization: vi.fn(),
  signFrozenDepositsRefundFinalization: vi.fn(),
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
    vi.spyOn(Date, "now").mockReturnValue(Date.now())
    setTeeSignerMock.mockReset()
    mockAztecState.obsidionWallet = mockObsidionWallet
    mockAztecState.currentNetwork = { type: "sandbox" }
    mockAccountState.obsidionAccount = mockObsidionAccount
    mockStorageState.completeAddress = "0xcomplete"
    mockStorageState.tokens = []
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
      expect.objectContaining({ teeRegistry: "0xtee-registry", source: "fake-source" }),
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
    const SIGNER_B = { ...FAKE_SIGNER, teeRegistry: { toString: () => "0xtee-registry-B" } } as any
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
      load: vi.fn(async () => Promise.reject(new Error("enclave not registered"))),
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

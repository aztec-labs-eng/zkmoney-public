/**
 * probeHistoricResiduals — attribution + per-probe isolation, with the sdk/front-core seams
 * stubbed. The real probes are covered by the funded Playwright spec; this pins the composition:
 * paylink rows attribute by tokenAddress (timestamp fallback), and one failing probe never hides
 * the others.
 */
import { describe, expect, it, vi } from "vitest"
import type { OxideEnvTuple } from "@obsidion/core/types"

// TokenService.create is the only sdk touch; stub it per-test.
const createMock = vi.hoisted(() => vi.fn())
vi.mock("@obsidion/sdk", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  TokenService: { create: createMock },
}))

import {
  countPendingWithdrawals,
  probeHistoricResiduals,
} from "../src/features/migration/historicResiduals"

const HISTORIC_L2_TOKEN = "0x" + "01".repeat(32)
const CURRENT_TS = "2026-08-14T10:00:00.000Z"

const tuple = (over: Partial<OxideEnvTuple> = {}): OxideEnvTuple =>
  ({
    version: "v5",
    gitSha: "",
    timestamp: "2026-08-14T09:00:00.000Z",
    portal: "0x" + "aa".repeat(20),
    token: "0x" + "cc".repeat(20),
    l2Token: HISTORIC_L2_TOKEN,
    enclaveUrl: "http://tee.example.test/rpc",
    pcr0: "",
    rollupVersion: "7",
    ...over,
  } as OxideEnvTuple)

const account = {
  getAddress: () => ({ toString: () => "0x" + "ee".repeat(32) }),
}

const payRow = (over: Record<string, unknown>) => ({
  emailPaymentAction: "Pay To Email",
  status: "success",
  paylink: "https://link",
  fallbackSecret: "0x1",
  fromClaimable: 0,
  untilClaimable: 1, // window long past → refund-eligible
  timestamp: Date.parse("2026-08-01T00:00:00Z"),
  ...over,
})

function deps(over: Record<string, unknown> = {}) {
  return {
    wallet: {} as never,
    account: account as never,
    publicClient: {} as never,
    current: tuple({ timestamp: CURRENT_TS, l2Token: "0x" + "02".repeat(32) }),
    historic: [tuple()],
    rows: [],
    nowSec: Math.floor(Date.parse("2026-08-15T00:00:00Z") / 1000),
    ...over,
  } as never
}

/** A multicall that answers every SIPA's token balance with `balance`, and no ETH. */
const balancesOf = (balance: bigint) =>
  vi.fn(async ({ contracts }: { contracts: { functionName: string }[] }) =>
    contracts.map((c) => ({ status: "success", result: c.functionName === "balanceOf" ? balance : 0n })),
  )

describe("probeHistoricResiduals", () => {
  it("reports a balance residual from the pinned historic token service", async () => {
    createMock.mockResolvedValueOnce({ getBalance: async () => 5n })
    const [summary] = await probeHistoricResiduals(deps())
    expect(summary!.balance).toBe(5n)
    expect(summary!.hasResiduals).toBe(true)
    // Pinned by explicit address — third arg is the historic l2Token.
    expect(createMock.mock.calls[0]![2].toString()).toBe(HISTORIC_L2_TOKEN)
  })

  it("reports a frozen portal's refundable notes instead of its token balance", async () => {
    createMock.mockClear()
    const [summary] = await probeHistoricResiduals(
      deps({
        frozenSource: async () => ({
          notes: 7n,
          links: 0n,
          deposits: 0,
          waiting: 0,
          waitingAmount: 0n,
        }),
      }),
    )
    expect(summary).toMatchObject({
      balance: 7n,
      frozen: true,
      incomplete: false,
      hasResiduals: true,
    })
    expect(createMock).not.toHaveBeenCalled()
  })

  it("reads the token balance while the portal is live", async () => {
    createMock.mockResolvedValueOnce({ getBalance: async () => 5n })
    const [summary] = await probeHistoricResiduals(deps({ frozenSource: async () => undefined }))
    expect(summary).toMatchObject({ balance: 5n, frozen: false })
  })

  it("finds a frozen source holding only an open link, and starts no reclaim for its rows", async () => {
    createMock.mockClear()
    const [summary] = await probeHistoricResiduals(
      deps({
        frozenSource: async () => ({
          notes: 0n,
          links: 20n,
          deposits: 0,
          waiting: 0,
          waitingAmount: 0n,
        }),
        rows: [
          payRow({ txHash: "0xa", tokenAddress: HISTORIC_L2_TOKEN }),
          // Legacy, pre-roll: attributed by its timestamp.
          payRow({ txHash: "0xb", untilClaimable: 2e9 }),
          payRow({ txHash: "0xc", tokenAddress: "0x" + "02".repeat(32) }),
        ],
      }),
    )
    expect(summary).toMatchObject({
      balance: 20n,
      frozen: true,
      paylinkEscrows: 0,
      lockedPaylinks: [],
      paylinkCandidates: [],
      hasResiduals: true,
    })
    expect(summary!.frozenLinks.map((row) => row.txHash)).toEqual(["0xa", "0xb"])
  })

  it("holds back the reclaims of a source whose frozen read failed", async () => {
    createMock.mockClear()
    const [summary] = await probeHistoricResiduals(
      deps({
        frozenSource: async () => Promise.reject(new Error("database held")),
        rows: [payRow({ txHash: "0xa", tokenAddress: HISTORIC_L2_TOKEN })],
      }),
    )
    expect(summary).toMatchObject({ incomplete: true, paylinkEscrows: 0, paylinkCandidates: [] })
    expect(summary!.frozenLinks.map((row) => row.txHash)).toEqual(["0xa"])
  })

  it("marks a failed frozen-source read incomplete instead of empty", async () => {
    createMock.mockClear()
    const [summary] = await probeHistoricResiduals(
      deps({ frozenSource: async () => Promise.reject(new Error("node down")) }),
    )
    expect(summary).toMatchObject({ balance: 0n, incomplete: true, hasResiduals: false })
    expect(createMock).not.toHaveBeenCalled()
  })

  it("attributes paylink rows by tokenAddress, with timestamp fallback for legacy rows", async () => {
    createMock.mockResolvedValue({ getBalance: async () => 0n })
    const rows = [
      payRow({ tokenAddress: HISTORIC_L2_TOKEN.toUpperCase() }), // matches (case-insensitive)
      payRow({ tokenAddress: "0x" + "02".repeat(32) }), // current-deployment row — excluded
      payRow({}), // legacy, pre-roll timestamp — included via fallback
      payRow({ timestamp: Date.parse("2026-08-15T00:00:00Z") }), // legacy, post-roll — excluded
      payRow({ tokenAddress: HISTORIC_L2_TOKEN, isClaimed: true }), // ineligible — excluded
    ]
    const [summary] = await probeHistoricResiduals(deps({ rows }))
    expect(summary!.paylinkEscrows).toBe(2)
    expect(summary!.hasResiduals).toBe(true)
  })

  it("reads a failing balance probe as incomplete, never hiding the paylink residuals", async () => {
    createMock.mockRejectedValue(new Error("pxe down"))
    const rows = [payRow({ tokenAddress: HISTORIC_L2_TOKEN })]
    const [summary] = await probeHistoricResiduals(deps({ rows }))
    expect(summary!.balance).toBe(0n)
    expect(summary!.incomplete).toBe(true)
    expect(summary!.paylinkEscrows).toBe(1)
    expect(summary!.hasResiduals).toBe(true)
  })

  it("finds an in-transit SIPA from broadcaster sources with no wallet records", async () => {
    createMock.mockResolvedValue({ getBalance: async () => 0n })
    const sipaAddress = "0x" + "77".repeat(20)
    const getContractEvents = vi.fn(async () => [])
    const [summary] = await probeHistoricResiduals(
      deps({
        publicClient: { getContractEvents, multicall: balancesOf(55n) } as never,
        sipaDiscovery: {
          scanRange: async () => ({ fromBlock: 10n, toBlock: 20n }),
          sources: async () => [
            {
              sipaAddress,
              recipientL2Address: account.getAddress().toString(),
              messageSecret: "0x01",
              recipientCommitment: "0x" + "0c".repeat(32),
            },
          ],
          consumed: async (_tuple: unknown, deposits: readonly unknown[]) => deposits.map(() => false),
        },
      }),
    )

    expect(summary).toMatchObject({
      sweptDeposits: 0,
      inTransitDeposits: 1,
      inTransitAmount: 55n,
      hasResiduals: true,
    })
    expect(getContractEvents).toHaveBeenCalledWith(
      expect.objectContaining({ fromBlock: 10n, toBlock: 20n }),
    )
  })

  it("counts a frozen portal's refundable deposits without the L2 claim check", async () => {
    const consumed = vi.fn(async (_tuple: unknown, deposits: readonly unknown[]) => deposits.map(() => true))
    const frozenSource = vi.fn(async (_tuple: unknown, descriptors: () => Promise<unknown[]>) => ({
      notes: 0n,
      links: 0n,
      deposits: (await descriptors()).length + 2,
      waiting: 1,
      waitingAmount: 9n,
    }))
    const [summary] = await probeHistoricResiduals(
      deps({
        publicClient: { getContractEvents: async () => [], multicall: balancesOf(55n) } as never,
        frozenSource,
        sipaDiscovery: {
          scanRange: async () => ({ fromBlock: 0n, toBlock: 20n }),
          sources: async () => [
            {
              sipaAddress: "0x" + "77".repeat(20),
              recipientL2Address: account.getAddress().toString(),
              messageSecret: "0x01",
              recipientCommitment: "0x" + "0c".repeat(32),
            },
          ],
          consumed,
        },
      }),
    )
    expect(summary).toMatchObject({
      frozen: true,
      sweptDeposits: 2,
      inTransitDeposits: 1,
      inTransitAmount: 55n,
      waitingDeposits: 1,
      waitingAmount: 9n,
      incomplete: false,
      hasResiduals: true,
    })
    expect(consumed).not.toHaveBeenCalled()
  })

  it("keeps a source whose only funds wait on an open Inbox tree as a residual", async () => {
    const [summary] = await probeHistoricResiduals(
      deps({
        frozenSource: async () => ({
          notes: 0n,
          links: 0n,
          deposits: 0,
          waiting: 1,
          waitingAmount: 9n,
        }),
      }),
    )
    expect(summary).toMatchObject({ frozen: true, waitingDeposits: 1, hasResiduals: true })
  })

  it("reports an incomplete probe when the SIPA scan fails without counting it as a residual", async () => {
    createMock.mockResolvedValue({ getBalance: async () => 0n })
    const [summary] = await probeHistoricResiduals(
      deps({
        publicClient: {
          getContractEvents: async () => Promise.reject(new Error("429")),
          multicall: balancesOf(0n),
        } as never,
        sipaDiscovery: {
          scanRange: async () => ({ fromBlock: 0n, toBlock: 20n }),
          sources: async () => [
            {
              sipaAddress: "0x" + "77".repeat(20),
              recipientL2Address: account.getAddress().toString(),
              messageSecret: "0x01",
              recipientCommitment: "0x" + "0c".repeat(32),
            },
          ],
          consumed: async (_tuple: unknown, deposits: readonly unknown[]) => deposits.map(() => false),
        },
      }),
    )
    expect(summary).toMatchObject({ incomplete: true, hasResiduals: false, inTransitDeposits: 0 })
  })

  it("probes every retired deployment when two rolls separate the funds from current (A → B → C)", async () => {
    const tokenA = HISTORIC_L2_TOKEN
    const tokenB = "0x" + "03".repeat(32)
    createMock.mockImplementation(
      async (_w: unknown, _a: unknown, addr: { toString(): string }) => ({
        getBalance: async () => (addr.toString() === tokenA ? 7n : 0n),
      }),
    )
    const summaries = await probeHistoricResiduals(
      deps({
        current: tuple({ timestamp: CURRENT_TS, l2Token: "0x" + "04".repeat(32) }),
        historic: [tuple({ l2Token: tokenB, portal: "0x" + "bb".repeat(20) }), tuple()],
      }),
    )
    expect(summaries.map((s) => [s.tuple.l2Token, s.balance, s.hasResiduals])).toEqual([
      [tokenB, 0n, false],
      [tokenA, 7n, true],
    ])
  })

  it("reports nothing when every probe is clean", async () => {
    createMock.mockResolvedValue({ getBalance: async () => 0n })
    const [summary] = await probeHistoricResiduals(deps())
    expect(summary!.hasResiduals).toBe(false)
  })
})

describe("countPendingWithdrawals", () => {
  it("counts only non-terminal withdrawals", () => {
    const rec = (phase: string) => ({ phase } as never)
    const phases = ["submitting", "l2_mined", "awaiting_proven", "finalizing_l1", "done", "failed"]
    expect(countPendingWithdrawals(phases.map(rec))).toBe(4)
    expect(countPendingWithdrawals([])).toBe(0)
  })
})

describe("probeHistoricResiduals — locked paylinks", () => {
  it("reports a within-window paylink as locked, not as a refundable escrow", async () => {
    createMock.mockResolvedValue({ getBalance: async () => 0n })
    const nowSec = Math.floor(Date.parse("2026-08-15T00:00:00Z") / 1000)
    const locked = payRow({ tokenAddress: HISTORIC_L2_TOKEN, untilClaimable: nowSec + 3600 })
    const [summary] = await probeHistoricResiduals(deps({ rows: [locked], nowSec }))
    expect(summary!.paylinkEscrows).toBe(0)
    expect(summary!.lockedPaylinks).toEqual([locked])
    expect(summary!.paylinkCandidates).toEqual([locked])
    expect(summary!.hasResiduals).toBe(true)
  })

  it("leaves paylinks unclassified but still recorded when chain time is unknown", async () => {
    createMock.mockResolvedValue({ getBalance: async () => 0n })
    const escrowed = payRow({ tokenAddress: HISTORIC_L2_TOKEN, untilClaimable: 1 })
    const claimed = payRow({ tokenAddress: HISTORIC_L2_TOKEN, isClaimed: true })
    const [summary] = await probeHistoricResiduals(
      deps({ rows: [escrowed, claimed], nowSec: null }),
    )
    expect(summary!.paylinkEscrows).toBe(0)
    expect(summary!.lockedPaylinks).toEqual([])
    expect(summary!.paylinkCandidates).toEqual([escrowed])
    expect(summary!.hasResiduals).toBe(true)
  })
})

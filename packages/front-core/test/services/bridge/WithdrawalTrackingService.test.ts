/**
 * WithdrawalTrackingService — the chain-watching lifecycle. The relayer is
 * headless (no status endpoint), so the tracker only OBSERVES: lazily derive
 * `withdrawalId`, poll the L2 receipt to proven-or-later, then poll the injected
 * finalization reader's authoritative `isSpent` to `done`.
 *
 * `@obsidion/sdk` is factory-mocked (not importActual) so the vendored `@oxide/*`
 * subpaths the real reader pulls stay out of this front-core test — the tracker
 * only needs `fetchWithdrawalsWithIds` from it at runtime.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { TxStatus, TxExecutionResult } from "@aztec/stdlib/tx"
import { ProvingStage, provingProgress } from "@obsidion/proving-progress"
import { trackWithdrawalSubmission } from "../../../src/core/services/bridge/WithdrawalTrackingService"
import type { Address, Hex } from "viem"
import type {
  SwapEscrowReader,
  WithdrawalFinalizationReader,
  WithdrawalPortalContext,
} from "@obsidion/sdk"

import { InMemoryStorageAdapter } from "../../__test-helpers__/InMemoryStorageAdapter"
import { resetSingleton } from "../../__test-helpers__/resetSingleton"
import { WithdrawalStorage } from "../../../src/core/services/bridge/WithdrawalStorage"
import {
  WithdrawalTrackingService,
  WITHDRAWAL_DELAYED_THRESHOLD_MS,
  SWAP_STUCK_THRESHOLD_MS,
  canRecoverSwap,
  canSelfExecuteSwap,
  canSelfFinalizeWithdrawal,
  isWithdrawalDelayed,
  type WithdrawalTrackerNode,
} from "../../../src/core/services/bridge/WithdrawalTrackingService"
import type { WithdrawalRecord } from "../../../src/core/services/bridge/types"

const mockFetch = vi.hoisted(() => vi.fn())
vi.mock("@obsidion/sdk", () => ({
  fetchWithdrawalsWithIds: mockFetch,
  swapRouteForOutput: (output: string) => ({ USDC: 0, USDT: 1, ETH: 2 }[output]),
}))

const RECIPIENT = "0x1234567890abcdef1234567890abcdef12345678" as Address
const L2TX_1 = ("0x" + "11".repeat(32)) as Hex
const L2TX_2 = ("0x" + "22".repeat(32)) as Hex
const WID_1 = ("0x" + "ab".repeat(32)) as Hex
const WID_2 = ("0x" + "cd".repeat(32)) as Hex
const L1TX = ("0x" + "ef".repeat(32)) as Hex

const PORTAL_CONTEXT: WithdrawalPortalContext = {
  l1Portal: ("0x" + "aa".repeat(20)) as Hex,
  l2Portal: "0x" + "bb".repeat(32),
  rollupVersion: 1n,
  l1ChainId: 11155111n,
}

/** Never-firing scheduler — tests drive `syncOnce()` explicitly for determinism. */
const NOOP_SCHEDULER = {
  setInterval: () => 0,
  clearInterval: () => {},
}

/** Withdrawal-id per burn tx so the two-identical-withdrawals test can disambiguate. */
function widForTx(l2TxHash: string): Hex {
  return l2TxHash.toLowerCase() === L2TX_1 ? WID_1 : WID_2
}

/** fetchWithdrawalsWithIds stub: derives the mapped id from the passed TxHash. */
function stubDerivation() {
  mockFetch.mockImplementation(async (_node: unknown, txHash: { toString(): string }) => ({
    withdrawals: [{ withdrawalId: { toString: () => widForTx(txHash.toString()) } }],
    anchorBlockHash: {},
  }))
}

function makeReader(
  overrides: Partial<WithdrawalFinalizationReader> = {},
): WithdrawalFinalizationReader {
  return {
    isSpent: vi.fn(async () => false),
    resolveL1TxHash: vi.fn(async () => undefined),
    ...overrides,
  }
}

const ESCROW = `0x${"e5".repeat(20)}` as Address
const FACTORY = `0x${"fa".repeat(20)}` as Address
const EXEC_TX = ("0x" + "5e".repeat(32)) as Hex

/** A funded escrow whose swap fills: the state right after the release. */
function makeEscrowReader(overrides: Partial<SwapEscrowReader> = {}): SwapEscrowReader {
  return {
    daiBalance: vi.fn(async () => 95n * 10n ** 18n),
    isDeployed: vi.fn(async () => false),
    deploySimulates: vi.fn(async () => true),
    executedTxHash: vi.fn(async () => undefined),
    recoveredTxHash: vi.fn(async () => undefined),
    ...overrides,
  }
}

function swapFields(): Partial<WithdrawalRecord> {
  return {
    swapOutput: "USDC",
    swapEscrow: ESCROW,
    swapEscrowFactory: FACTORY,
    swapNonce: ("0x" + "77".repeat(32)) as Hex,
    swapRecoveryCommitment: `0x${"5a".repeat(32)}` as Hex,
    swapRelayerTip: "5000000000000000000",
  }
}

function makeNode(status: TxStatus = TxStatus.PENDING): WithdrawalTrackerNode {
  return { getTxReceipt: vi.fn(async () => ({ status })) } as unknown as WithdrawalTrackerNode
}

function resetSingletons() {
  resetSingleton(WithdrawalStorage as unknown as { instance: WithdrawalStorage | null })
  WithdrawalTrackingService.reset()
}

async function seedStore(): Promise<WithdrawalStorage> {
  const store = WithdrawalStorage.get(new InMemoryStorageAdapter())
  await store.load()
  return store
}

function submittingRecord(localId: string): WithdrawalRecord {
  return {
    localId,
    recipient: RECIPIENT,
    recipientProvenance: "saved-recipient",
    amount: "1.0",
    tokenSymbol: "DAI",
    phase: "submitting",
    startTime: 1_700_000_000_000,
  }
}

describe("WithdrawalTrackingService (chain-watching)", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    resetSingletons()
    mockFetch.mockReset()
    stubDerivation()
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
  })

  afterEach(() => {
    WithdrawalTrackingService.reset()
    warnSpy.mockRestore()
  })

  describe("get singleton API", () => {
    it("throws when the first call has no options", () => {
      expect(() => WithdrawalTrackingService.get()).toThrow(
        /First call to WithdrawalTrackingService\.get\(\) requires/,
      )
    })

    it("lists the missing dependency when options are incomplete", async () => {
      const store = await seedStore()
      expect(() =>
        WithdrawalTrackingService.get({
          store,
          node: makeNode(),
          // finalizationReader + portalContext omitted
        } as unknown as Parameters<typeof WithdrawalTrackingService.get>[0]),
      ).toThrow(/finalizationReader, portalContext/)
    })

    it("first-call-wins: later no-arg calls return the same instance", async () => {
      const store = await seedStore()
      const first = WithdrawalTrackingService.get({
        store,
        node: makeNode(),
        finalizationReader: makeReader(),
        portalContext: PORTAL_CONTEXT,
        scheduler: NOOP_SCHEDULER,
      })
      expect(WithdrawalTrackingService.get()).toBe(first)
    })
  })

  describe("happy path", () => {
    it.each([TxStatus.DROPPED, TxStatus.PROVEN])(
      "recovers a terminal unsuccessful paylink receipt %s without waiting for a burn log",
      async (status) => {
        const store = await seedStore()
        await store.create({ ...submittingRecord("w1"), source: "paylink", l2TxHash: L2TX_1 })
        const node = makeNode(status)
        vi.mocked(node.getTxReceipt).mockResolvedValue({
          status,
          executionResult: TxExecutionResult.REVERTED,
        } as never)
        const tracker = WithdrawalTrackingService.get({
          store,
          node,
          finalizationReader: makeReader(),
          portalContext: PORTAL_CONTEXT,
          scheduler: NOOP_SCHEDULER,
        })
        const active = trackWithdrawalSubmission(store, "w1", "operation")
        try {
          await tracker.syncOnce()
          expect(node.getTxReceipt).not.toHaveBeenCalled()
          expect(store.get("w1")?.phase).toBe("submitting")
        } finally {
          await active.stop()
        }
        await tracker.syncOnce()
        expect(store.get("w1")?.phase).toBe("failed")
        expect(mockFetch).not.toHaveBeenCalled()
      },
    )

    it("recovers a broadcast burn after the sender loses its receipt", async () => {
      const store = await seedStore()
      await store.create({ ...submittingRecord("w1"), l2TxHash: L2TX_1 })
      const node = makeNode(TxStatus.PROVEN)
      vi.mocked(node.getTxReceipt).mockResolvedValue({
        status: TxStatus.PROVEN,
        blockNumber: 100,
      } as never)
      const tracker = WithdrawalTrackingService.get({
        store,
        node,
        finalizationReader: makeReader(),
        portalContext: PORTAL_CONTEXT,
        scheduler: NOOP_SCHEDULER,
      })
      mockFetch.mockResolvedValueOnce({ withdrawals: [] })
      await tracker.syncOnce()
      expect(store.get("w1")?.phase).toBe("submitting")
      mockFetch.mockResolvedValueOnce({
        withdrawals: [
          {
            withdrawalId: { toString: () => WID_1 },
            amount: 1000000n,
            relayerTip: 100n,
          },
        ],
      })
      await tracker.syncOnce()
      expect(store.get("w1")).toMatchObject({
        phase: "finalizing_l1",
        blockNumber: 100,
        rawAmount: "1000000",
        relayerTip: "100",
        withdrawalId: WID_1,
      })
    })

    it("watch arms, first tick derives + advances to finalizing_l1, next tick reaches done with the L1 link", async () => {
      const store = await seedStore()
      await store.create(submittingRecord("w1"))
      await store.markMined("w1", L2TX_1, 100, "1000000")

      const reader = makeReader({
        isSpent: vi.fn(async () => true),
        resolveL1TxHash: vi.fn(async () => L1TX),
      })
      const node = makeNode(TxStatus.PROVEN)
      const tracker = WithdrawalTrackingService.get({
        store,
        node,
        finalizationReader: reader,
        portalContext: PORTAL_CONTEXT,
        scheduler: NOOP_SCHEDULER,
      })

      // Arming does not derive up front.
      await tracker.watch(store.get("w1")!)
      expect(mockFetch).not.toHaveBeenCalled()
      expect(store.get("w1")?.phase).toBe("l2_mined")
      expect(store.get("w1")?.phaseEnteredAt).toBeGreaterThan(0)

      // Tick 1: derive + stamp withdrawalId, receipt proven → finalizing_l1.
      await tracker.syncOnce()
      expect(store.get("w1")?.withdrawalId).toBe(WID_1)
      expect(store.get("w1")?.phase).toBe("finalizing_l1")

      // Tick 2: isSpent → done + resolved L1 link.
      await tracker.syncOnce()
      const done = store.get("w1")!
      expect(done.phase).toBe("done")
      expect(done.l1TxHash).toBe(L1TX)
      expect(done.endTime).toBeGreaterThan(0)
      expect(reader.resolveL1TxHash).toHaveBeenCalledWith(WID_1)
    })

    it("looks the release tx up by withdrawalId alone, whatever the burn paid or netted", async () => {
      // The portal's `WithdrawalOrRefund` log carries the withdrawalId as its nullifier, so neither
      // the escrow a swap burn paid nor the net the portal released keys the lookup.
      const store = await seedStore()
      await store.create({ ...submittingRecord("w1"), ...swapFields(), fpcFundingCut: "50000" })
      await store.markMined("w1", L2TX_1, 100, "1000000", "100000")

      const reader = makeReader({
        isSpent: vi.fn(async () => true),
        resolveL1TxHash: vi.fn(async () => L1TX),
      })
      const tracker = WithdrawalTrackingService.get({
        store,
        node: makeNode(TxStatus.PROVEN),
        finalizationReader: reader,
        portalContext: PORTAL_CONTEXT,
        scheduler: NOOP_SCHEDULER,
      })
      await tracker.watch(store.get("w1")!)
      await tracker.syncOnce()
      await tracker.syncOnce()

      expect(store.get("w1")?.l1TxHash).toBe(L1TX)
      expect(reader.resolveL1TxHash).toHaveBeenCalledWith(WID_1)
    })
  })

  describe("per-deployment bindings", () => {
    it("a record stamped with a retired portal derives and polls against that portal, not the live one", async () => {
      const store = await seedStore()
      const retired = {
        portal: ("0x" + "cc".repeat(20)) as Hex,
        pool: ("0x" + "dd".repeat(20)) as Hex,
        l2Token: "0x" + "ee".repeat(32),
      }
      await store.create({ ...submittingRecord("w1"), deployment: retired })
      await store.markMined("w1", L2TX_1, 100, "1000000")

      const liveReader = makeReader()
      const retiredReader = makeReader({ isSpent: vi.fn(async () => true) })
      const readerForDeployment = vi.fn(() => retiredReader)
      const tracker = WithdrawalTrackingService.get({
        store,
        node: makeNode(TxStatus.PROVEN),
        finalizationReader: liveReader,
        portalContext: PORTAL_CONTEXT,
        readerForDeployment,
        scheduler: NOOP_SCHEDULER,
      })

      await tracker.watch(store.get("w1")!)
      await tracker.syncOnce()
      await tracker.syncOnce()

      expect(store.get("w1")?.phase).toBe("done")
      expect(mockFetch).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ l1Portal: retired.portal, l2Portal: retired.l2Token }),
      )
      expect(readerForDeployment).toHaveBeenCalledWith(retired)
      expect(retiredReader.isSpent).toHaveBeenCalled()
      expect(liveReader.isSpent).not.toHaveBeenCalled()
    })

    it("a record stamped with the live portal keeps the boot-time reader", async () => {
      const store = await seedStore()
      await store.create({
        ...submittingRecord("w1"),
        deployment: {
          portal: PORTAL_CONTEXT.l1Portal,
          pool: ("0x" + "dd".repeat(20)) as Hex,
          l2Token: PORTAL_CONTEXT.l2Portal,
        },
      })
      await store.markMined("w1", L2TX_1, 100, "1000000")
      const liveReader = makeReader({ isSpent: vi.fn(async () => true) })
      const readerForDeployment = vi.fn(() => makeReader())
      const tracker = WithdrawalTrackingService.get({
        store,
        node: makeNode(TxStatus.PROVEN),
        finalizationReader: liveReader,
        portalContext: PORTAL_CONTEXT,
        readerForDeployment,
        scheduler: NOOP_SCHEDULER,
      })
      await tracker.watch(store.get("w1")!)
      await tracker.syncOnce()
      await tracker.syncOnce()
      expect(store.get("w1")?.phase).toBe("done")
      expect(readerForDeployment).not.toHaveBeenCalled()
    })
  })

  describe("lazy withdrawalId derivation", () => {
    it("a missing-effect throw leaves the record armed at l2_mined; a later tick derives and completes", async () => {
      const store = await seedStore()
      await store.create(submittingRecord("w1"))
      await store.markMined("w1", L2TX_1, 100, "1000000")

      const reader = makeReader({
        isSpent: vi.fn(async () => true),
        resolveL1TxHash: vi.fn(async () => undefined),
      })
      const node = makeNode(TxStatus.PROVEN)
      const tracker = WithdrawalTrackingService.get({
        store,
        node,
        finalizationReader: reader,
        portalContext: PORTAL_CONTEXT,
        scheduler: NOOP_SCHEDULER,
      })
      await tracker.watch(store.get("w1")!)

      // Tick 1: derivation throws (burn effect not yet indexed) → deferred, not failed.
      mockFetch.mockRejectedValueOnce(new Error("Tx effect not found for hash 0x…"))
      await tracker.syncOnce()
      expect(store.get("w1")?.phase).toBe("l2_mined")
      expect(store.get("w1")?.withdrawalId).toBeUndefined()
      expect(node.getTxReceipt as ReturnType<typeof vi.fn>).not.toHaveBeenCalled()

      // Tick 2: derivation succeeds → advances; Tick 3: isSpent → done.
      await tracker.syncOnce()
      expect(store.get("w1")?.withdrawalId).toBe(WID_1)
      expect(store.get("w1")?.phase).toBe("finalizing_l1")
      await tracker.syncOnce()
      expect(store.get("w1")?.phase).toBe("done")
    })
  })

  describe("proven-or-finalized predicate", () => {
    it("advances an awaiting_proven record whose receipt returns finalized (skipped past proven)", async () => {
      const store = await seedStore()
      await store.create(submittingRecord("w1"))
      await store.markMined("w1", L2TX_1, 100, "1000000")
      await store.patch("w1", { phase: "awaiting_proven", withdrawalId: WID_1 })

      const node = makeNode(TxStatus.FINALIZED)
      const tracker = WithdrawalTrackingService.get({
        store,
        node,
        finalizationReader: makeReader(),
        portalContext: PORTAL_CONTEXT,
        scheduler: NOOP_SCHEDULER,
      })
      await tracker.watch(store.get("w1")!)

      await tracker.syncOnce()
      expect(store.get("w1")?.phase).toBe("finalizing_l1")
    })

    it("boot-resume of a record returning finalized advances the same way", async () => {
      const store = await seedStore()
      await store.create(submittingRecord("w1"))
      await store.markMined("w1", L2TX_1, 100, "1000000")
      await store.patch("w1", { phase: "awaiting_proven", withdrawalId: WID_1 })

      const node = makeNode(TxStatus.FINALIZED)
      const tracker = WithdrawalTrackingService.get({
        store,
        node,
        finalizationReader: makeReader(),
        portalContext: PORTAL_CONTEXT,
        scheduler: NOOP_SCHEDULER,
      })
      await tracker.resumeAll()

      await tracker.syncOnce()
      expect(store.get("w1")?.phase).toBe("finalizing_l1")
    })
  })

  describe("reorg demote", () => {
    it("a demoted record re-advances: the tracker threads the record's epoch through its writes", async () => {
      const store = await seedStore()
      await store.create(submittingRecord("w1"))
      await store.markMined("w1", L2TX_1, 100, "1000000")
      await store.patch("w1", { phase: "awaiting_proven", withdrawalId: WID_1 })
      await store.demote("w1") // → l2_mined, epoch 1

      const node = makeNode(TxStatus.FINALIZED)
      const tracker = WithdrawalTrackingService.get({
        store,
        node,
        finalizationReader: makeReader({ isSpent: vi.fn(async () => true) }),
        portalContext: PORTAL_CONTEXT,
        scheduler: NOOP_SCHEDULER,
      })
      await tracker.resumeAll()

      await tracker.syncOnce()
      expect(store.get("w1")?.phase).toBe("finalizing_l1")
      await tracker.syncOnce()
      expect(store.get("w1")?.phase).toBe("done")
      expect(store.get("w1")?.reorgEpoch).toBe(1)
    })
  })

  describe("delayed presentation (derived, non-terminal)", () => {
    it("flags a post-mine record past the threshold in any post-mine phase, never pre-mine/terminal", () => {
      const now = 10_000_000_000
      const past = now - WITHDRAWAL_DELAYED_THRESHOLD_MS - 1
      const recent = now - 60_000

      const base = submittingRecord("w1")
      for (const phase of ["l2_mined", "awaiting_proven", "finalizing_l1"] as const) {
        expect(isWithdrawalDelayed({ ...base, phase, phaseEnteredAt: past }, now)).toBe(true)
        expect(isWithdrawalDelayed({ ...base, phase, phaseEnteredAt: recent }, now)).toBe(false)
      }
      expect(isWithdrawalDelayed({ ...base, phase: "submitting" }, now)).toBe(false)
      expect(isWithdrawalDelayed({ ...base, phase: "done", phaseEnteredAt: past }, now)).toBe(false)
      expect(isWithdrawalDelayed({ ...base, phase: "failed", phaseEnteredAt: past }, now)).toBe(
        false,
      )
    })

    it("offers the manual finalize only to a delayed finalizing_l1 burn nothing has been sent for", () => {
      const now = 10_000_000_000
      const stuck: WithdrawalRecord = {
        ...submittingRecord("w1"),
        phase: "finalizing_l1",
        phaseEnteredAt: now - WITHDRAWAL_DELAYED_THRESHOLD_MS - 1,
        l2TxHash: L2TX_1,
        withdrawalId: WID_1,
      }
      expect(canSelfFinalizeWithdrawal(stuck, now)).toBe(true)

      // Still finalizing normally: the relayer's window has not run out.
      expect(canSelfFinalizeWithdrawal({ ...stuck, phaseEnteredAt: now - 60_000 }, now)).toBe(false)
      // The L2 leg is not done, so there is nothing on L1 to push through yet.
      expect(canSelfFinalizeWithdrawal({ ...stuck, phase: "awaiting_proven" }, now)).toBe(false)
      // Everything the call re-derives comes from the burn tx hash.
      expect(canSelfFinalizeWithdrawal({ ...stuck, l2TxHash: undefined }, now)).toBe(false)
      // One is already in flight.
      expect(canSelfFinalizeWithdrawal({ ...stuck, finalizeTxHash: L1TX }, now)).toBe(false)
    })

    it("a stalled finalizing_l1 record (isSpent never true) stays non-terminal — never failed", async () => {
      const store = await seedStore()
      await store.create(submittingRecord("w1"))
      await store.markMined("w1", L2TX_1, 100, "1000000")
      await store.patch("w1", { phase: "finalizing_l1", withdrawalId: WID_1 })

      const reader = makeReader({ isSpent: vi.fn(async () => false) })
      const tracker = WithdrawalTrackingService.get({
        store,
        node: makeNode(TxStatus.PROVEN),
        finalizationReader: reader,
        portalContext: PORTAL_CONTEXT,
        scheduler: NOOP_SCHEDULER,
      })
      await tracker.watch(store.get("w1")!)

      for (let i = 0; i < 5; i++) await tracker.syncOnce()
      expect(store.get("w1")?.phase).toBe("finalizing_l1")
      expect(reader.isSpent).toHaveBeenCalled()
    })
  })

  describe("pre-mine records", () => {
    // A burn whose tab closed after submit has only its stored hash; the tracker settles it.
    it("fails a submitted wallet withdrawal whose receipt says dropped", async () => {
      const store = await seedStore()
      await store.create(submittingRecord("w1"))
      await store.patch("w1", { phase: "submitting", l2TxHash: L2TX_1 })
      const tracker = WithdrawalTrackingService.get({
        store,
        node: makeNode(TxStatus.DROPPED),
        finalizationReader: makeReader(),
        portalContext: PORTAL_CONTEXT,
        scheduler: NOOP_SCHEDULER,
      })
      await tracker.watch(store.get("w1")!)
      await tracker.syncOnce()

      expect(store.get("w1")).toMatchObject({
        phase: "failed",
        error: "The withdrawal transaction was dropped or reverted. You can try again.",
      })
    })

    it("keeps a submitted wallet withdrawal pending while the node has no verdict", async () => {
      const store = await seedStore()
      await store.create(submittingRecord("w1"))
      await store.patch("w1", { phase: "submitting", l2TxHash: L2TX_1 })
      const tracker = WithdrawalTrackingService.get({
        store,
        node: makeNode(TxStatus.PENDING),
        finalizationReader: makeReader(),
        portalContext: PORTAL_CONTEXT,
        scheduler: NOOP_SCHEDULER,
      })
      await tracker.watch(store.get("w1")!)
      await tracker.syncOnce()

      expect(store.get("w1")?.phase).toBe("submitting")
    })

    it("never touches a submitting record (no l2TxHash) — failed is a pre-mine local concern", async () => {
      const store = await seedStore()
      await store.create(submittingRecord("w1"))

      const node = makeNode(TxStatus.PROVEN)
      const tracker = WithdrawalTrackingService.get({
        store,
        node,
        finalizationReader: makeReader(),
        portalContext: PORTAL_CONTEXT,
        scheduler: NOOP_SCHEDULER,
      })
      await tracker.resumeAll()
      await tracker.syncOnce()

      expect(store.get("w1")?.phase).toBe("submitting")
      expect(mockFetch).not.toHaveBeenCalled()
      expect(node.getTxReceipt as ReturnType<typeof vi.fn>).not.toHaveBeenCalled()
    })
  })

  describe("two identical (recipient, amount) withdrawals", () => {
    it("each binds its own withdrawalId; isSpent advances exactly one; links don't cross", async () => {
      const store = await seedStore()
      await store.create(submittingRecord("w1"))
      await store.markMined("w1", L2TX_1, 100, "1000000")
      await store.create(submittingRecord("w2"))
      await store.markMined("w2", L2TX_2, 100, "1000000")

      const reader = makeReader({
        isSpent: vi.fn(async (id: Hex) => id.toLowerCase() === WID_1),
        resolveL1TxHash: vi.fn(async (id: Hex) => (id.toLowerCase() === WID_1 ? L1TX : undefined)),
      })
      const tracker = WithdrawalTrackingService.get({
        store,
        node: makeNode(TxStatus.PROVEN),
        finalizationReader: reader,
        portalContext: PORTAL_CONTEXT,
        scheduler: NOOP_SCHEDULER,
      })
      await tracker.resumeAll()

      // Tick 1: both derive + advance to finalizing_l1. Tick 2: only w1 is spent.
      await tracker.syncOnce()
      await tracker.syncOnce()

      expect(store.get("w1")?.withdrawalId).toBe(WID_1)
      expect(store.get("w2")?.withdrawalId).toBe(WID_2)
      expect(store.get("w1")?.phase).toBe("done")
      expect(store.get("w1")?.l1TxHash).toBe(L1TX)
      expect(store.get("w2")?.phase).toBe("finalizing_l1")
      expect(store.get("w2")?.l1TxHash).toBeUndefined()
    })
  })

  describe("boot-resume", () => {
    it("re-arms non-terminal records, drives them forward, and never regresses a done record", async () => {
      const store = await seedStore()
      // A terminal done, a non-terminal finalizing_l1, and a pre-mine submitting.
      await store.create(submittingRecord("done1"))
      await store.markMined("done1", L2TX_2, 50, "500000")
      await store.patch("done1", { phase: "done", withdrawalId: WID_2, l1TxHash: L1TX })

      await store.create(submittingRecord("w1"))
      await store.markMined("w1", L2TX_1, 100, "1000000")
      await store.patch("w1", { phase: "finalizing_l1", withdrawalId: WID_1 })

      await store.create(submittingRecord("pre1"))

      const reader = makeReader({
        isSpent: vi.fn(async () => true),
        resolveL1TxHash: vi.fn(async () => undefined),
      })
      const tracker = WithdrawalTrackingService.get({
        store,
        node: makeNode(TxStatus.PROVEN),
        finalizationReader: reader,
        portalContext: PORTAL_CONTEXT,
        scheduler: NOOP_SCHEDULER,
      })
      await tracker.resumeAll()
      await tracker.syncOnce()

      expect(store.get("w1")?.phase).toBe("done")
      expect(store.get("done1")?.phase).toBe("done")
      expect(store.get("done1")?.l1TxHash).toBe(L1TX)
      expect(store.get("pre1")?.phase).toBe("submitting")
    })
  })

  describe("retry (post-mine re-poll)", () => {
    it("re-polls a stalled post-mine record on demand and reaches done once spent", async () => {
      const store = await seedStore()
      await store.create(submittingRecord("w1"))
      await store.markMined("w1", L2TX_1, 100, "1000000")
      await store.patch("w1", { phase: "finalizing_l1", withdrawalId: WID_1 })

      const isSpent = vi.fn(async () => true)
      const tracker = WithdrawalTrackingService.get({
        store,
        node: makeNode(TxStatus.PROVEN),
        finalizationReader: makeReader({ isSpent }),
        portalContext: PORTAL_CONTEXT,
        scheduler: NOOP_SCHEDULER,
      })
      await tracker.watch(store.get("w1")!)

      await tracker.retry(L2TX_1)
      expect(store.get("w1")?.phase).toBe("done")
    })

    it("is a no-op on a terminal or unknown record", async () => {
      const store = await seedStore()
      await store.create(submittingRecord("w1"))
      await store.markMined("w1", L2TX_1, 100, "1000000")
      await store.patch("w1", { phase: "done", withdrawalId: WID_1, l1TxHash: L1TX })

      const isSpent = vi.fn(async () => true)
      const tracker = WithdrawalTrackingService.get({
        store,
        node: makeNode(TxStatus.PROVEN),
        finalizationReader: makeReader({ isSpent }),
        portalContext: PORTAL_CONTEXT,
        scheduler: NOOP_SCHEDULER,
      })

      await tracker.retry(L2TX_1)
      await tracker.retry(L2TX_2) // unknown
      expect(isSpent).not.toHaveBeenCalled()
      expect(store.get("w1")?.phase).toBe("done")
    })
  })

  describe("RPC errors fail loud and retry", () => {
    it("an isSpent throw keeps the record non-terminal, then completes on the next tick", async () => {
      const store = await seedStore()
      await store.create(submittingRecord("w1"))
      await store.markMined("w1", L2TX_1, 100, "1000000")
      await store.patch("w1", { phase: "finalizing_l1", withdrawalId: WID_1 })

      const isSpent = vi
        .fn<[Hex], Promise<boolean>>()
        .mockRejectedValueOnce(new Error("RPC down"))
        .mockResolvedValue(true)
      const tracker = WithdrawalTrackingService.get({
        store,
        node: makeNode(TxStatus.PROVEN),
        finalizationReader: makeReader({ isSpent }),
        portalContext: PORTAL_CONTEXT,
        scheduler: NOOP_SCHEDULER,
      })
      await tracker.watch(store.get("w1")!)

      await tracker.syncOnce()
      expect(store.get("w1")?.phase).toBe("finalizing_l1")
      expect(warnSpy).toHaveBeenCalled()

      await tracker.syncOnce()
      expect(store.get("w1")?.phase).toBe("done")
    })

    it("a getTxReceipt throw keeps the record non-terminal and retries", async () => {
      const store = await seedStore()
      await store.create(submittingRecord("w1"))
      await store.markMined("w1", L2TX_1, 100, "1000000")
      await store.patch("w1", { phase: "awaiting_proven", withdrawalId: WID_1 })

      const getTxReceipt = vi
        .fn()
        .mockRejectedValueOnce(new Error("RPC down"))
        .mockResolvedValue({ status: TxStatus.PROVEN })
      const node = { getTxReceipt } as unknown as WithdrawalTrackerNode
      const tracker = WithdrawalTrackingService.get({
        store,
        node,
        finalizationReader: makeReader(),
        portalContext: PORTAL_CONTEXT,
        scheduler: NOOP_SCHEDULER,
      })
      await tracker.watch(store.get("w1")!)

      await tracker.syncOnce()
      expect(store.get("w1")?.phase).toBe("awaiting_proven")

      await tracker.syncOnce()
      expect(store.get("w1")?.phase).toBe("finalizing_l1")
    })
  })
  describe("swap leg", () => {
    /** A swap record released to its escrow, tracked with `reader`; returns the tracker. */
    async function releasedSwap(
      store: WithdrawalStorage,
      reader: SwapEscrowReader,
      fields: Partial<WithdrawalRecord> = swapFields(),
    ) {
      await store.create({ ...submittingRecord("w1"), ...fields })
      await store.markMined("w1", L2TX_1, 100, "1000000")
      const tracker = WithdrawalTrackingService.get({
        store,
        node: makeNode(TxStatus.PROVEN),
        finalizationReader: makeReader({ isSpent: vi.fn(async () => true) }),
        portalContext: PORTAL_CONTEXT,
        swapEscrowReader: reader,
        scheduler: NOOP_SCHEDULER,
      })
      await tracker.watch(store.get("w1")!)
      await tracker.syncOnce() // derive + proven → finalizing_l1
      await tracker.syncOnce() // released
      return tracker
    }

    it("a release funds the escrow: the record parks at swapping, and a fillable deploy keeps it there", async () => {
      const store = await seedStore()
      const reader = makeEscrowReader()
      const tracker = await releasedSwap(store, reader)

      expect(store.get("w1")?.phase).toBe("swapping")
      expect(store.get("w1")?.phaseEnteredAt).toBeGreaterThan(0)
      expect(reader.deploySimulates).toHaveBeenCalledWith(
        FACTORY,
        expect.objectContaining({ route: 0, recipient: RECIPIENT, nonce: swapFields().swapNonce }),
      )
      await tracker.syncOnce()
      expect(store.get("w1")?.phase).toBe("swapping")
    })

    it("without an escrow reader a swap record settles done at the release, like a direct one", async () => {
      const store = await seedStore()
      await store.create({ ...submittingRecord("w1"), ...swapFields() })
      await store.markMined("w1", L2TX_1, 100, "1000000")
      const tracker = WithdrawalTrackingService.get({
        store,
        node: makeNode(TxStatus.PROVEN),
        finalizationReader: makeReader({ isSpent: vi.fn(async () => true) }),
        portalContext: PORTAL_CONTEXT,
        scheduler: NOOP_SCHEDULER,
      })
      await tracker.watch(store.get("w1")!)
      await tracker.syncOnce()
      await tracker.syncOnce()
      expect(store.get("w1")?.phase).toBe("done")
    })

    it("an emptied, deployed escrow means the swap ran: done, with the executed tx", async () => {
      const store = await seedStore()
      const reader = makeEscrowReader()
      const tracker = await releasedSwap(store, reader)

      ;(reader.daiBalance as ReturnType<typeof vi.fn>).mockResolvedValue(0n)
      ;(reader.isDeployed as ReturnType<typeof vi.fn>).mockResolvedValue(true)
      ;(reader.executedTxHash as ReturnType<typeof vi.fn>).mockResolvedValue(EXEC_TX)
      await tracker.syncOnce()

      const done = store.get("w1")!
      expect(done.phase).toBe("done")
      expect(done.swapExecuteTxHash).toBe(EXEC_TX)
      expect(done.endTime).toBeGreaterThan(0)
      expect(reader.executedTxHash).toHaveBeenCalledWith(FACTORY, ESCROW)
    })

    it("an empty escrow with no code is a release not yet visible: the tick defers", async () => {
      const store = await seedStore()
      const reader = makeEscrowReader({ daiBalance: vi.fn(async () => 0n) })
      await releasedSwap(store, reader)
      expect(store.get("w1")?.phase).toBe("swapping")
      expect(reader.deploySimulates).not.toHaveBeenCalled()
    })

    it("a funded escrow whose deploy reverts is recoverable", async () => {
      const store = await seedStore()
      const reader = makeEscrowReader({ deploySimulates: vi.fn(async () => false) })
      await releasedSwap(store, reader)
      expect(store.get("w1")?.phase).toBe("recoverable")
    })

    it("a recoverable escrow whose deploy fills again goes back to swapping", async () => {
      const store = await seedStore()
      const reader = makeEscrowReader({ deploySimulates: vi.fn(async () => false) })
      const tracker = await releasedSwap(store, reader)
      expect(store.get("w1")?.phase).toBe("recoverable")
      ;(reader.deploySimulates as ReturnType<typeof vi.fn>).mockResolvedValue(true)
      await tracker.syncOnce()
      expect(store.get("w1")?.phase).toBe("swapping")
    })

    it("a recoverable escrow emptied by a recovery is recovered, from the escrow's log", async () => {
      const store = await seedStore()
      const reader = makeEscrowReader({ deploySimulates: vi.fn(async () => false) })
      const tracker = await releasedSwap(store, reader)
      ;(reader.daiBalance as ReturnType<typeof vi.fn>).mockResolvedValue(0n)
      ;(reader.isDeployed as ReturnType<typeof vi.fn>).mockResolvedValue(true)
      ;(reader.recoveredTxHash as ReturnType<typeof vi.fn>).mockResolvedValue({
        txHash: EXEC_TX,
        target: RECIPIENT,
      })
      await tracker.syncOnce()
      const recovered = store.get("w1")!
      expect(recovered.phase).toBe("recovered")
      expect(recovered.recoveryTxHash).toBe(EXEC_TX)
      expect(recovered.recoveryTarget).toBe(RECIPIENT)
      expect(recovered.endTime).toBeGreaterThan(0)
      expect(reader.recoveredTxHash).toHaveBeenCalledWith(ESCROW)
    })

    it("a recoverable escrow emptied with no log of either kind settles done", async () => {
      const store = await seedStore()
      const reader = makeEscrowReader({ deploySimulates: vi.fn(async () => false) })
      const tracker = await releasedSwap(store, reader)

      ;(reader.daiBalance as ReturnType<typeof vi.fn>).mockResolvedValue(0n)
      ;(reader.isDeployed as ReturnType<typeof vi.fn>).mockResolvedValue(true)
      await tracker.syncOnce()
      expect(store.get("w1")?.phase).toBe("done")
      expect(store.get("w1")?.swapExecuteTxHash).toBeUndefined()
    })

    it("a failed executed-log read defers the verdict to the next tick", async () => {
      const store = await seedStore()
      const reader = makeEscrowReader({ deploySimulates: vi.fn(async () => false) })
      const tracker = await releasedSwap(store, reader)

      ;(reader.daiBalance as ReturnType<typeof vi.fn>).mockResolvedValue(0n)
      ;(reader.isDeployed as ReturnType<typeof vi.fn>).mockResolvedValue(true)
      ;(reader.executedTxHash as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("rpc down"),
      )
      await tracker.syncOnce()
      expect(store.get("w1")?.phase).toBe("recoverable")
      expect(warnSpy).toHaveBeenCalled()
      ;(reader.executedTxHash as ReturnType<typeof vi.fn>).mockResolvedValue(EXEC_TX)
      await tracker.syncOnce()
      expect(store.get("w1")?.phase).toBe("done")
      expect(store.get("w1")?.swapExecuteTxHash).toBe(EXEC_TX)
    })

    it("a recoverable escrow emptied by an execution after all is done", async () => {
      const store = await seedStore()
      const reader = makeEscrowReader({ deploySimulates: vi.fn(async () => false) })
      const tracker = await releasedSwap(store, reader)

      ;(reader.daiBalance as ReturnType<typeof vi.fn>).mockResolvedValue(0n)
      ;(reader.isDeployed as ReturnType<typeof vi.fn>).mockResolvedValue(true)
      ;(reader.executedTxHash as ReturnType<typeof vi.fn>).mockResolvedValue(EXEC_TX)
      await tracker.syncOnce()
      expect(store.get("w1")?.phase).toBe("done")
      expect(store.get("w1")?.swapExecuteTxHash).toBe(EXEC_TX)
    })

    it("a record without a recovery commitment cannot be simulated: it waits on a relayer", async () => {
      const store = await seedStore()
      const reader = makeEscrowReader({ deploySimulates: vi.fn(async () => false) })
      const { swapRecoveryCommitment: _omitted, ...incomplete } = swapFields()
      await releasedSwap(store, reader, incomplete)
      expect(store.get("w1")?.phase).toBe("swapping")
      expect(reader.deploySimulates).not.toHaveBeenCalled()
    })

    it("a reader failure leaves the phase untouched and retries next tick", async () => {
      const store = await seedStore()
      const reader = makeEscrowReader()
      const tracker = await releasedSwap(store, reader)

      ;(reader.daiBalance as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("rpc down"))
      await tracker.syncOnce()
      expect(store.get("w1")?.phase).toBe("swapping")
      expect(warnSpy).toHaveBeenCalled()
      ;(reader.daiBalance as ReturnType<typeof vi.fn>).mockResolvedValue(0n)
      ;(reader.isDeployed as ReturnType<typeof vi.fn>).mockResolvedValue(true)
      await tracker.syncOnce()
      expect(store.get("w1")?.phase).toBe("done")
    })

    it("terminal recovered records are not ticked", async () => {
      const store = await seedStore()
      const reader = makeEscrowReader({ deploySimulates: vi.fn(async () => false) })
      const tracker = await releasedSwap(store, reader)
      await store.patch(L2TX_1, { phase: "recovered", recoveryTxHash: EXEC_TX })
      ;(reader.daiBalance as ReturnType<typeof vi.fn>).mockClear()
      await tracker.syncOnce()
      expect(reader.daiBalance).not.toHaveBeenCalled()
    })
  })

  describe("canSelfExecuteSwap / canRecoverSwap", () => {
    const now = 1_700_000_000_000
    const swapping = (): WithdrawalRecord => ({
      ...submittingRecord("w1"),
      ...swapFields(),
      l2TxHash: L2TX_1,
      phase: "swapping",
      phaseEnteredAt: now - SWAP_STUCK_THRESHOLD_MS,
    })

    it("offers the self-run once a swapping record has waited out the relayer's budget", () => {
      expect(canSelfExecuteSwap(swapping(), now)).toBe(true)
      expect(canSelfExecuteSwap({ ...swapping(), phaseEnteredAt: now - 1000 }, now)).toBe(false)
    })

    it("withholds the self-run while one is in flight, and from records that cannot rebuild args", () => {
      expect(canSelfExecuteSwap({ ...swapping(), swapExecuteTxHash: EXEC_TX }, now)).toBe(false)
      expect(canSelfExecuteSwap({ ...swapping(), swapRecoveryCommitment: undefined }, now)).toBe(
        false,
      )
      expect(canSelfExecuteSwap({ ...swapping(), phase: "finalizing_l1" }, now)).toBe(false)
    })

    it("offers recovery on a parked recoverable record with args", () => {
      expect(canRecoverSwap({ ...swapping(), phase: "recoverable" })).toBe(true)
      expect(canRecoverSwap({ ...swapping(), phase: "recoverable", swapNonce: undefined })).toBe(
        false,
      )
      expect(canRecoverSwap(swapping())).toBe(false)
    })

    it("a swapping record is delayed on the same derivation as the other post-mine phases", () => {
      expect(isWithdrawalDelayed(swapping(), now, SWAP_STUCK_THRESHOLD_MS)).toBe(true)
      expect(isWithdrawalDelayed({ ...swapping(), phase: "recoverable" }, now, 0)).toBe(false)
    })
  })
})

// `sent` is a claim about storage: a hash stamp that did not persist is never announced as saved.
describe("trackWithdrawalSubmission's hash stamp", () => {
  beforeEach(() => resetSingletons())

  it.each([
    ["persists", false, true],
    ["fails to persist", true, false],
  ])("announces the hash only when the stamp %s", async (_label, failWrites, announced) => {
    const adapter = new InMemoryStorageAdapter()
    const store = WithdrawalStorage.get(adapter)
    await store.load()
    await store.create(submittingRecord("w1"))
    if (failWrites) adapter.setItem = async () => Promise.reject(new Error("quota"))
    const heard = vi.fn()
    provingProgress.on("tx-hash-saved", heard)
    const submission = trackWithdrawalSubmission(store, "w1", "op")
    try {
      provingProgress.emitStageStart(ProvingStage.Mining, "op", L2TX_1)
      await submission.stop()
      expect(await submission.saved()).toBe(announced)
      expect(heard).toHaveBeenCalledTimes(announced ? 1 : 0)
    } finally {
      provingProgress.off("tx-hash-saved", heard)
    }
  })

  it("stamps without announcing for a record that rides another record's tx", async () => {
    const store = await seedStore()
    await store.create(submittingRecord("w1"))
    const heard = vi.fn()
    provingProgress.on("tx-hash-saved", heard)
    const submission = trackWithdrawalSubmission(store, "w1", "op", { announce: false })
    try {
      provingProgress.emitStageStart(ProvingStage.Mining, "op", L2TX_1)
      await submission.stop()
      expect(await submission.saved()).toBe(true)
      expect(store.get("w1")?.l2TxHash).toBe(L2TX_1)
      expect(heard).not.toHaveBeenCalled()
    } finally {
      provingProgress.off("tx-hash-saved", heard)
    }
  })
})

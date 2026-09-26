import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { QueueStatus } from "@obsidion/sdk"
import { AccountStorage } from "../../../src/core/storages/AccountStorage"
import { NetworkStorage } from "../../../src/core/storages/NetworkStorage"
import { TransactionStorage } from "../../../src/core/storages/TransactionStorage"
import { WithdrawalStorage } from "../../../src/core/services/bridge/WithdrawalStorage"
import { SIPADepositStore } from "../../../src/core/services/deposits/SIPADepositStore"
import { TransactionTracker } from "../../../src/core/services/transactions/TransactionTracker"
import {
  ReorgMonitor,
  runFreezeSweep,
  type ConfirmationOutcome,
  type ReorgMonitorDeps,
} from "../../../src/core/services/coordination/ReorgMonitor"
import type { ReorgTxReceiptLike } from "../../../src/core/services/chain/receiptTypes"
import type { TokenInTxService } from "../../../src/types"
import { TRANSACTIONS_STORAGE_KEY } from "../../../src/core/storages/constants"
import { InMemoryStorageAdapter } from "../../__test-helpers__/InMemoryStorageAdapter"
import { resetSingleton } from "../../__test-helpers__/resetSingleton"

vi.mock("@aztec/aztec.js/node", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aztec/aztec.js/node")>()
  return { ...actual, createAztecNodeClient: vi.fn() }
})

const TX = "0x" + "ab".repeat(32)
const TX2 = "0x" + "cd".repeat(32)
const TX3 = "0x" + "ef".repeat(32)

const sampleToken = (): TokenInTxService => ({
  name: "ETH",
  decimals: 18,
  logo: "https://example.com/eth.png",
  price: 1000,
  symbol: "ETH",
  address: "0xtoken",
  amount: 1,
  hasUnknownAmount: false,
})

const resetSingletons = () => {
  resetSingleton(AccountStorage as unknown as { instance: AccountStorage | null })
  resetSingleton(TransactionStorage as unknown as { instance: TransactionStorage | null })
  resetSingleton(NetworkStorage as unknown as { instance: NetworkStorage | null })
  resetSingleton(WithdrawalStorage as unknown as { instance: WithdrawalStorage | null })
  resetSingleton(SIPADepositStore as unknown as { instance: SIPADepositStore | null })
}

const stubTracker = () => {
  ;(TransactionTracker as unknown as { instance: unknown }).instance = null
  const tracker = TransactionTracker.getInstance()
  vi.spyOn(tracker, "getQueue").mockReturnValue([])
}

/** Scripted node: per-hash receipt or "throw"; records call order. */
function makeNode() {
  const scripts = new Map<string, ReorgTxReceiptLike | "throw">()
  const calls: string[] = []
  return {
    script(txHash: string, entry: ReorgTxReceiptLike | "throw") {
      scripts.set(txHash.toLowerCase(), entry)
    },
    calls,
    node: {
      async getTxReceipt(txHash: string): Promise<ReorgTxReceiptLike> {
        calls.push(txHash.toLowerCase())
        const entry = scripts.get(txHash.toLowerCase())
        if (!entry || entry === "throw") throw new Error("rpc down / no script for " + txHash)
        return entry
      },
    },
  }
}

async function seedRow(
  txHash: string,
  opts: {
    status?: "pending" | "success" | "failed"
    blockNumber?: number
    blockHash?: string
    networkId?: string
  } = {},
) {
  const transactions = TransactionStorage.get()
  await transactions.addTokenTransaction(
    "send",
    sampleToken(),
    "pending",
    txHash,
    "0xr",
    "q-" + txHash.slice(-4),
  )
  await transactions.updateTransaction(
    (tx) => tx.txHash === txHash,
    (tx) => {
      if (opts.blockNumber !== undefined) tx.blockNumber = opts.blockNumber
      if (opts.blockHash !== undefined) tx.blockHash = opts.blockHash
      if (opts.networkId !== undefined) tx.networkId = opts.networkId
    },
  )
  if (opts.status === "success") {
    await transactions.updateByTxHash(txHash, QueueStatus.SUCCESS, 1111)
  } else if (opts.status === "failed") {
    await transactions.updateByTxHash(txHash, QueueStatus.FAILED, 1111)
  }
}

async function rowByHash(txHash: string) {
  const txs = await TransactionStorage.get().getTransactions()
  return txs.find((t) => (t.txHash ?? "").toLowerCase() === txHash.toLowerCase())!
}

function setup() {
  resetSingletons()
  stubTracker()
  const adapter = new InMemoryStorageAdapter()
  AccountStorage.get(adapter)
  TransactionStorage.get(adapter)
  const chain = makeNode()
  const outcomes: ConfirmationOutcome[] = []
  const deps: ReorgMonitorDeps = {
    node: chain.node,
    transactionStorage: TransactionStorage.get(),
    onOutcome: (o) => outcomes.push(o),
  }
  return { adapter, chain, outcomes, deps }
}

const runPass = (deps: ReorgMonitorDeps, opts?: { sideEffects?: boolean }) =>
  new ReorgMonitor(deps).runPass(opts ?? { sideEffects: true })

describe("ReorgMonitor.runPass", () => {
  beforeEach(() => resetSingletons())
  afterEach(() => vi.restoreAllMocks())

  it("confirmed payment dropped while app closed → failed on open, alert outcome", async () => {
    const { chain, outcomes, deps } = setup()
    await seedRow(TX, { status: "success", blockNumber: 42, blockHash: "0xb42" })
    chain.script(TX, { status: "dropped" })

    const summary = await runPass(deps)

    const row = await rowByHash(TX)
    expect(row.status).toBe("failed")
    expect(row.detailedStatus).toBe(QueueStatus.FAILED)
    expect(row.reorgEpoch).toBe(1)
    expect(summary).toMatchObject({ checked: 1, failed: 1, demoted: 0, reConfirmed: 0 })
    expect(outcomes).toEqual([{ type: "failed", txHash: TX, reorgEpoch: 1 }])
  })

  it("rows on a foreign network are untouched — no receipt fetch, no writes", async () => {
    const { chain, deps } = setup()
    await seedRow(TX, { status: "success", blockNumber: 42, networkId: "net-B" })
    chain.script(TX, { status: "dropped" })

    const summary = await runPass({ ...deps, networkId: "net-A" })

    expect(chain.calls).toEqual([])
    expect(summary.checked).toBe(0)
    expect((await rowByHash(TX)).status).toBe("success")
  })

  it("previously-failed row found re-included → re-confirmed with anchor", async () => {
    const { chain, outcomes, deps } = setup()
    await seedRow(TX, { status: "failed" })
    chain.script(TX, {
      status: "proposed",
      blockNumber: 50,
      blockHash: "0xb50",
      executionResult: "success",
    })

    const summary = await runPass(deps)

    const row = await rowByHash(TX)
    expect(row.status).toBe("success")
    expect(row.blockNumber).toBe(50)
    expect(row.blockHash).toBe("0xb50")
    expect(row.tier).toBe("proposed")
    expect(summary.reConfirmed).toBe(1)
    expect(outcomes).toEqual([{ type: "re-confirmed", txHash: TX, hadAlerted: true }])
  })

  it("healthy confirmed rows are left unchanged", async () => {
    const { chain, outcomes, deps } = setup()
    await seedRow(TX, { status: "success", blockNumber: 42, blockHash: "0xb42" })
    await TransactionStorage.get().updateTransaction(
      (tx) => tx.txHash === TX,
      (tx) => {
        tx.tier = "proposed"
      },
    )
    chain.script(TX, { status: "proposed", blockNumber: 42, blockHash: "0xb42" })

    const summary = await runPass(deps)

    expect((await rowByHash(TX)).status).toBe("success")
    expect(summary).toMatchObject({ checked: 1, demoted: 0, failed: 0, reConfirmed: 0 })
    expect(outcomes).toEqual([])
  })

  it("confirmed row regressed to the mempool → demoted, grace window armed", async () => {
    const { chain, outcomes, deps } = setup()
    await seedRow(TX, { status: "success", blockNumber: 42, blockHash: "0xb42" })
    chain.script(TX, { status: "pending" })

    const summary = await runPass(deps)

    const row = await rowByHash(TX)
    expect(row.status).toBe("pending")
    expect(row.reorgEpoch).toBe(1)
    expect(summary.demoted).toBe(1)
    expect(outcomes).toEqual([{ type: "demoted", txHash: TX }])
  })

  it("confirmed row re-included at the same height with a new hash → demoted", async () => {
    const { chain, outcomes, deps } = setup()
    await seedRow(TX, { status: "success", blockNumber: 42, blockHash: "0xb42" })
    chain.script(TX, { status: "proposed", blockNumber: 42, blockHash: "0xb42b" })

    const summary = await runPass(deps)

    const row = await rowByHash(TX)
    expect(row.status).toBe("pending")
    expect(row.reorgEpoch).toBe(1)
    expect(summary.demoted).toBe(1)
    expect(outcomes).toEqual([{ type: "demoted", txHash: TX }])
  })

  it("rows beyond the four surfaces (faucet, paylink-create) are reconciled", async () => {
    const { chain, deps } = setup()
    const transactions = TransactionStorage.get()
    await transactions.addFaucetTransaction(sampleToken(), "success", TX)
    // paylink row seeded raw — the persisted discriminator is emailPaymentAction
    const rows = await transactions.getTransactions()
    rows.push({
      timestamp: 1,
      status: "success",
      txHash: TX2,
      action: "Pay To Email",
      emailPaymentAction: "Pay To Email",
      flavor: "direct",
    } as (typeof rows)[number])
    await (transactions as unknown as { storage: InMemoryStorageAdapter }).storage.setItem(
      TRANSACTIONS_STORAGE_KEY,
      JSON.stringify(rows),
    )

    chain.script(TX, { status: "dropped" })
    chain.script(TX2, { status: "dropped" })

    const summary = await runPass(deps)

    expect(summary.failed).toBe(2)
    expect((await rowByHash(TX)).status).toBe("failed")
    expect((await rowByHash(TX2)).status).toBe("failed")
  })

  it("a throwing receipt lookup skips the row, leaving it unchanged", async () => {
    const { chain, outcomes, deps } = setup()
    await seedRow(TX, { status: "success", blockNumber: 42 })
    await seedRow(TX2, { status: "success", blockNumber: 43 })
    chain.script(TX, "throw")
    chain.script(TX2, { status: "dropped" })

    const summary = await runPass(deps)

    expect((await rowByHash(TX)).status).toBe("success")
    expect((await rowByHash(TX2)).status).toBe("failed")
    expect(summary).toMatchObject({ checked: 2, failed: 1 })
    expect(outcomes).toEqual([{ type: "failed", txHash: TX2, reorgEpoch: 1 }])
  })

  it("finalized receipt marks the tier finalized and emits finalized; the row leaves the walk", async () => {
    const { chain, outcomes, deps } = setup()
    await seedRow(TX, { status: "success", blockNumber: 42, blockHash: "0xb42" })
    chain.script(TX, { status: "finalized", blockNumber: 42, blockHash: "0xb42" })

    await runPass(deps)

    expect((await rowByHash(TX)).tier).toBe("finalized")
    expect(outcomes).toEqual([{ type: "finalized", txHash: TX }])

    // finalized rows are excluded from later walks — no more receipt reads
    chain.calls.length = 0
    await runPass(deps)
    expect(chain.calls).toEqual([])
  })

  it("the PXE sync kick runs after record writes and after the withdrawal re-check", async () => {
    const { chain, deps } = setup()
    await seedRow(TX, { status: "success", blockNumber: 42 })
    chain.script(TX, { status: "dropped" })

    const order: string[] = []
    let statusAtSync: string | undefined
    const summary = await runPass({
      ...deps,
      rerunWithdrawalFinalization: async () => {
        order.push("l1-check")
      },
      kickPxeSync: async () => {
        order.push("sync")
        statusAtSync = (await rowByHash(TX)).status
      },
    })

    expect(order).toEqual(["l1-check", "sync"])
    expect(statusAtSync).toBe("failed")
    expect(summary.failed).toBe(1)
  })

  it("a pass without sideEffects skips the withdrawal re-check and the PXE kick", async () => {
    const { chain, deps } = setup()
    await seedRow(TX, { status: "success", blockNumber: 42 })
    chain.script(TX, { status: "dropped" })

    const order: string[] = []
    await runPass(
      {
        ...deps,
        rerunWithdrawalFinalization: async () => {
          order.push("l1-check")
        },
        kickPxeSync: async () => {
          order.push("sync")
        },
      },
      { sideEffects: false },
    )

    expect(order).toEqual([])
    expect((await rowByHash(TX)).status).toBe("failed")
  })

  it("reverted included receipt fails a confirmed row — never SUCCESS", async () => {
    const { chain, outcomes, deps } = setup()
    await seedRow(TX, { status: "success", blockNumber: 42, blockHash: "0xb42" })
    chain.script(TX, {
      status: "proposed",
      blockNumber: 42,
      blockHash: "0xb42",
      executionResult: "reverted",
    })

    const summary = await runPass(deps)

    const row = await rowByHash(TX)
    expect(row.status).toBe("failed")
    expect(row.reorgEpoch).toBe(1)
    expect(summary.failed).toBe(1)
    expect(summary.reConfirmed).toBe(0)
    expect(outcomes).toEqual([{ type: "failed", txHash: TX, reorgEpoch: 1 }])
  })

  it("reverted finalized receipt fails the row — no SUCCESS write", async () => {
    const { chain, outcomes, deps } = setup()
    await seedRow(TX, { status: "pending" })
    chain.script(TX, { status: "finalized", blockNumber: 42, executionResult: "reverted" })

    await runPass(deps)

    expect((await rowByHash(TX)).status).toBe("failed")
    expect(outcomes).toEqual([{ type: "failed", txHash: TX, reorgEpoch: 1 }])
  })

  it("undefined executionResult never flips a failed row to SUCCESS (included or finalized)", async () => {
    const { chain, outcomes, deps } = setup()
    await seedRow(TX, { status: "failed" })
    await seedRow(TX2, { status: "failed" })
    chain.script(TX, { status: "proposed", blockNumber: 50, blockHash: "0xb50" })
    chain.script(TX2, { status: "finalized", blockNumber: 51, blockHash: "0xb51" })

    const summary = await runPass(deps)

    expect((await rowByHash(TX)).status).toBe("failed")
    expect((await rowByHash(TX2)).status).toBe("failed")
    expect(summary.reConfirmed).toBe(0)
    expect(outcomes).toEqual([])
  })

  it("demote then re-inclusion inside grace re-confirms quietly across passes", async () => {
    const { chain, outcomes, deps } = setup()
    const monitor = new ReorgMonitor(deps)
    await seedRow(TX, { status: "success", blockNumber: 42, blockHash: "0xb42" })
    chain.script(TX, { status: "pending" })

    await monitor.runPass()
    expect((await rowByHash(TX)).status).toBe("pending")

    chain.script(TX, { status: "proposed", blockNumber: 50, blockHash: "0xb50" })
    await monitor.runPass()

    const row = await rowByHash(TX)
    expect(row.status).toBe("success")
    expect(row.blockNumber).toBe(50)
    expect(row.reorgEpoch).toBe(1)
    expect(outcomes).toEqual([
      { type: "demoted", txHash: TX },
      { type: "re-confirmed", txHash: TX, hadAlerted: false, reorgEpoch: 1 },
    ])
  })

  it("grace expiry alerts once, then a late re-inclusion issues the corrective", async () => {
    const { chain, outcomes, deps } = setup()
    let clock = 1_000
    const monitor = new ReorgMonitor({ ...deps, graceWindowMs: 500, now: () => clock })
    await seedRow(TX, { status: "success", blockNumber: 42, blockHash: "0xb42" })
    chain.script(TX, { status: "pending" })

    await monitor.runPass() // demote; grace deadline = 1_500
    clock = 2_000
    await monitor.runPass() // still pending past deadline → grace-expired
    await monitor.runPass() // no duplicate alert
    expect(outcomes).toEqual([
      { type: "demoted", txHash: TX },
      { type: "grace-expired", txHash: TX, reorgEpoch: 1 },
    ])
    expect((await rowByHash(TX)).status).toBe("pending")

    chain.script(TX, { status: "proposed", blockNumber: 50, blockHash: "0xb50" })
    await monitor.runPass()
    expect((await rowByHash(TX)).status).toBe("success")
    expect(outcomes.at(-1)).toEqual({
      type: "re-confirmed",
      txHash: TX,
      hadAlerted: true,
      reorgEpoch: 1,
    })
  })

  it("holds an in-flight row's first dropped reading for 10 seconds before failing it", async () => {
    const { chain, outcomes, deps } = setup()
    // Pending with a hash: stamped before the node received the tx, so the node reads it as dropped.
    await seedRow(TX)
    chain.script(TX, { status: "dropped" })
    let clock = 1_000_000
    const monitor = new ReorgMonitor({ ...deps, now: () => clock })

    await monitor.runPass({ sideEffects: true })
    expect((await rowByHash(TX)).status).toBe("pending")
    clock += 9_999
    await monitor.runPass({ sideEffects: true })
    expect((await rowByHash(TX)).status).toBe("pending")
    expect(outcomes).toEqual([])

    clock += 1
    await monitor.runPass({ sideEffects: true })
    expect((await rowByHash(TX)).status).toBe("failed")
    expect(outcomes).toEqual([{ type: "failed", txHash: TX, reorgEpoch: 1 }])
  })

  it("an in-flight row the node includes inside the settle window confirms and drops the window", async () => {
    const { chain, deps } = setup()
    await seedRow(TX)
    chain.script(TX, { status: "dropped" })
    let clock = 1_000_000
    const monitor = new ReorgMonitor({ ...deps, now: () => clock })
    await monitor.runPass({ sideEffects: true })

    chain.script(TX, { status: "proposed", blockNumber: 42, blockHash: "0xb42" })
    clock += 5_000
    await monitor.runPass({ sideEffects: true })
    expect((await rowByHash(TX)).status).toBe("success")
    // A later dropped reading is a fresh episode, not the tail of the settled one.
    chain.script(TX, { status: "dropped" })
    clock += 200_000
    await monitor.runPass({ sideEffects: true })
    expect((await rowByHash(TX)).status).toBe("failed")
  })

  it("a demoted row whose receipt reads dropped terminal-fails with the alert", async () => {
    const { chain, outcomes, deps } = setup()
    const monitor = new ReorgMonitor(deps)
    await seedRow(TX, { status: "success", blockNumber: 42, blockHash: "0xb42" })
    chain.script(TX, { status: "pending" })
    await monitor.runPass()

    chain.script(TX, { status: "dropped" })
    await monitor.runPass()

    expect((await rowByHash(TX)).status).toBe("failed")
    // the failure stays inside the demote's episode: same epoch, so its alert id
    // dedupes against any grace-expired alert already minted for this reorg
    expect(outcomes).toEqual([
      { type: "demoted", txHash: TX },
      { type: "failed", txHash: TX, reorgEpoch: 1 },
    ])
  })

  it("a frozen probe skips the pass entirely", async () => {
    const { chain, deps } = setup()
    await seedRow(TX, { status: "success", blockNumber: 42 })
    chain.script(TX, { status: "dropped" })

    const summary = await runPass({ ...deps, isFrozen: async () => true })

    expect(summary).toBeNull()
    expect(chain.calls).toEqual([])
    expect((await rowByHash(TX)).status).toBe("success")
  })

  it("requestPass triggers landing mid-pass coalesce into one trailing re-run", async () => {
    const { deps } = setup()
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    let passes = 0
    const monitor = new ReorgMonitor({
      ...deps,
      transactionStorage: {
        async getTransactions() {
          passes++
          if (passes === 1) await gate
          return []
        },
        demoteByTxHash: () => Promise.reject(new Error("unused")),
        updateByTxHash: () => Promise.reject(new Error("unused")),
        updateTransaction: () => Promise.reject(new Error("unused")),
      },
    })

    monitor.requestPass()
    monitor.requestPass()
    monitor.requestPass()
    expect(passes).toBe(1)

    release()
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))
    expect(passes).toBe(2)
  })

  it("runFreezeSweep terminal-fails non-finalized rows and emits exit-required, no receipt fetches", async () => {
    const { chain, outcomes, deps } = setup()
    await seedRow(TX, { status: "success", blockNumber: 42, networkId: "net-A" }) // at risk
    await seedRow(TX2, { status: "pending", networkId: "net-A" }) // at risk
    await seedRow(TX3, { status: "failed", networkId: "net-A" }) // already failed: nothing to exit
    const finTx = "0x" + "44".repeat(32)
    await seedRow(finTx, { status: "success" })
    await TransactionStorage.get().updateTransaction(
      (tx) => tx.txHash === finTx,
      (tx) => {
        tx.tier = "finalized"
      },
    )
    const foreignTx = "0x" + "55".repeat(32)
    await seedRow(foreignTx, { status: "success", networkId: "net-B" })

    const adapter = new InMemoryStorageAdapter()
    const withdrawals = WithdrawalStorage.get(adapter)
    const wTx = ("0x" + "66".repeat(32)) as `0x${string}`
    await withdrawals.create({
      localId: "wdraw_f",
      recipient: "0x" + "11".repeat(20),
      recipientProvenance: "saved-recipient",
      amount: "1",
      tokenSymbol: "DAI",
      phase: "submitting",
      startTime: 1,
      networkId: "net-A",
    } as Parameters<typeof withdrawals.create>[0])
    await withdrawals.markMined("wdraw_f", wTx, 42, "1000")

    const result = await runFreezeSweep({
      transactionStorage: TransactionStorage.get(),
      withdrawalStorage: withdrawals,
      networkId: "net-A",
      onOutcome: (o) => outcomes.push(o),
    })

    expect(chain.calls).toEqual([])
    expect((await rowByHash(TX)).status).toBe("failed")
    expect((await rowByHash(TX)).reorgEpoch).toBe(1)
    expect((await rowByHash(TX2)).status).toBe("failed")
    expect((await rowByHash(finTx)).status).toBe("success")
    expect((await rowByHash(foreignTx)).status).toBe("success")
    const w = withdrawals.get("wdraw_f")
    expect(w?.phase).toBe("failed")
    expect(w?.error).toBe("Generation frozen — withdraw via exit flow")
    expect(result.swept).toBe(3)
    expect(outcomes).toEqual(
      expect.arrayContaining([
        { type: "exit-required", txHash: TX },
        { type: "exit-required", txHash: TX2 },
        { type: "exit-required", txHash: wTx },
      ]),
    )
    expect(outcomes).toHaveLength(3)
  })

  it("withdrawal and SIPA records reconcile through their own demote paths", async () => {
    const { chain, deps } = setup()
    const adapter = new InMemoryStorageAdapter()
    const withdrawals = WithdrawalStorage.get(adapter)
    await withdrawals.create({
      localId: "wdraw_1",
      recipient: "0x" + "11".repeat(20),
      recipientProvenance: "saved-recipient",
      amount: "1",
      tokenSymbol: "DAI",
      phase: "submitting",
      startTime: 1,
    } as Parameters<typeof withdrawals.create>[0])
    await withdrawals.markMined("wdraw_1", TX as `0x${string}`, 42, "1000")

    const sipa = SIPADepositStore.get(adapter)
    await sipa.upsert(
      ("0x" + "22".repeat(20)) as `0x${string}`,
      { phase: "claimed", claimTxHash: TX2 },
      {
        recipientL2Address: "0xl2",
        messageSecret: "0x1",
        recipientHash: "0x2",
        recoveryAddress: "0x3",
        l1ChainId: 1,
        amount: "1",
        tokenSymbol: "DAI",
        startTime: 1,
      },
    )

    chain.script(TX, { status: "dropped" }) // withdrawal burn dropped
    // SIPA claim re-included but reverted: gone from chain effect-wise, same undo as dropped
    chain.script(TX2, {
      status: "proposed",
      blockNumber: 60,
      blockHash: "0xb60",
      executionResult: "reverted",
    })

    const summary = await runPass({
      ...deps,
      withdrawalStorage: withdrawals,
      sipaDepositStore: sipa,
    })

    expect(withdrawals.get("wdraw_1")?.phase).toBe("failed")
    expect(sipa.get(("0x" + "22".repeat(20)) as `0x${string}`)?.phase).toBe("pendingClaim")
    expect(summary.failed).toBe(1) // the burn
    expect(summary.demoted).toBe(1) // SIPA
  })
})

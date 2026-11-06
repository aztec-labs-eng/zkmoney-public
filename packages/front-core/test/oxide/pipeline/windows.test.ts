// @vitest-environment node
/** Observation windows: a SIPA reads its history once, then rides its portal's cursor. */
import { describe, expect, it, vi } from "vitest"
import { erc20Abi, formatUnits, type Abi } from "viem"
import { arrivingFunds } from "../../../src/engine/activityFeed"
import { isUnfundedSipaDeposit } from "../../../src/engine/sipaDepositTransition"
import { sipaCursorKey, type SipaDeposit } from "../../../src/engine/sipaDeposits"
import {
  DAI,
  DAI_ROW,
  FEE,
  PORTAL,
  pipelineWorld,
  RECIPIENT,
  salt,
  USDC,
  type PipelineWorld,
} from "./world"

const ONE = 10n ** 18n
const OVERLAP = 128n

const setCursor = (w: PipelineWorld, block: bigint) =>
  w.db.write(async (tx) => tx.put(sipaCursorKey(PORTAL, RECIPIENT.toString()), String(block)))

/** Each distinct block range the pass read logs over, in order. */
const ranges = (w: PipelineWorld) => [
  ...new Map(
    w.l1.calls.filter((c) => c.range).map((c) => [c.range!.join(":"), c.range!] as const),
  ).values(),
]

const arriving = (deposits: SipaDeposit[]) =>
  arrivingFunds({ deposits, burns: [], moves: [], rows: [] }).main

/** A record whose history was read, riding the cursor. */
async function observed(w: PipelineWorld, n: number, over: Partial<SipaDeposit> = {}) {
  const sipa = await w.announced(n)
  await w.saved(sipa, {
    phase: "broadcast",
    observedFrom: (w.l1.head - 1_000n).toString(),
    ...over,
  })
  return sipa
}

describe("observation windows", () => {
  const START = 600_000n

  it("reads a new SIPA's whole history, then only the blocks since the deployment's cursor", async () => {
    const w = await pipelineWorld()
    const sipa = await w.announced(1)
    const historyStartBlock = vi.fn(async () => START)
    await w.scan({ historyStartBlock })
    expect(await w.get(sipa.address)).toMatchObject({ observedFrom: w.l1.head.toString() })
    expect(await w.cursor()).toBe(w.l1.head)

    await w.scan({ historyStartBlock })

    expect(ranges(w)).toEqual([
      [START, w.l1.head],
      [w.l1.head - OVERLAP, w.l1.head],
    ])
    expect(historyStartBlock).toHaveBeenCalledTimes(1)
  })

  it("takes the default look-back for a new SIPA when the history start cannot be read", async () => {
    const w = await pipelineWorld()
    const sipa = await w.announced(1)

    await w.scan({
      historyStartBlock: async () => {
        throw new Error("rpc down")
      },
    })

    expect(ranges(w)).toEqual([[w.l1.head - 50_000n, w.l1.head]])
    // A partial read marks nothing read: the next pass tries the history again.
    expect((await w.get(sipa.address))?.observedFrom).toBeUndefined()
  })

  it("observes the other SIPAs when one window fails, and leaves the failed one its window", async () => {
    const w = await pipelineWorld()
    await setCursor(w, w.l1.head - 1n)
    const old = await observed(w, 2)
    const fresh = await w.announced(1)
    w.pay(fresh.address, ONE)
    w.sweep(fresh, 7n)
    // The riding window's reads fail; the fresh SIPA's backfill window answers.
    w.l1.failing = (c) => c.method === "eth_getLogs" && c.range![0] === w.l1.head - 1n - OVERLAP

    const { scanned: result, claimed } = await w.pass({
      scan: { historyStartBlock: async () => START },
    })

    expect(result.failed).toBe(1)
    expect(claimed.claimed).toBe(1)
    expect(await w.get(old.address)).toMatchObject({
      rescanFrom: (w.l1.head - 1n - OVERLAP).toString(),
    })
    expect(await w.cursor()).toBe(w.l1.head)
  })

  it("leaves its window to a SIPA whose holdings read failed, reading nothing of it alone", async () => {
    const w = await pipelineWorld()
    await setCursor(w, w.l1.head - 1_000n)
    const funded = await observed(w, 1)
    const swept = await observed(w, 2)
    w.pay(funded.address, ONE)
    w.pay(swept.address, ONE, undefined, w.l1.head - 510n)
    w.sweep(swept, 7n, { block: w.l1.head - 500n })
    w.l1.failing = (c) => c.fn === "aggregate3"

    const first = await w.pass()

    expect(first.scanned.failed).toBe(2)
    expect(first.claimed.claimed).toBe(0)
    expect(w.l1.count({ method: "eth_call", fn: "balanceOf" })).toBe(0)
    expect(w.l1.count({ method: "eth_getBalance" })).toBe(0)
    expect(await w.cursor()).toBe(w.l1.head)

    // The cursor passed the sweep: only the window the failed pass left reads it.
    w.l1.failing = () => false
    const second = await w.pass()

    expect(second.claimed.claimed).toBe(1)
    expect(await w.get(funded.address)).toMatchObject({ phase: "sweeping" })
  })

  it("finds a deposit swept long before the cursor on a fresh device", async () => {
    const w = await pipelineWorld()
    const sipa = await w.announced(1)
    w.pay(sipa.address, ONE, undefined, w.l1.head - 300_010n)
    w.sweep(sipa, 7n, { block: w.l1.head - 300_000n })

    await w.pass({ scan: { historyStartBlock: async () => START } })

    expect(w.l2.claims).toHaveLength(1)
    expect(await w.get(sipa.address)).toMatchObject({ phase: "claimed", amount: "0.9" })
  })

  it("reads a record added after the cursor from the start, beside one that rides the cursor", async () => {
    const w = await pipelineWorld()
    await setCursor(w, w.l1.head - 10n)
    await observed(w, 2, { phase: "claimed", endTime: 1, amount: "1" })
    await w.announced(1)

    await w.scan({ historyStartBlock: async () => START })

    expect(ranges(w)).toEqual(
      expect.arrayContaining([
        [START, w.l1.head],
        [w.l1.head - 10n - OVERLAP, w.l1.head],
      ]),
    )
  })

  it("watches a settled SIPA every pass, so a second payment is seen at once", async () => {
    const w = await pipelineWorld()
    await setCursor(w, w.l1.head - 1n)
    const sipa = await observed(w, 1, {
      phase: "claimed",
      claimedInboxIndexes: ["7"],
      endTime: 1,
      amount: "0.9",
      fee: FEE.toString(),
      sweeps: [{ inboxIndex: "7", sweepTxHash: `0x${"5e".repeat(32)}`, netAmount: "900" }],
    })
    w.pay(sipa.address, ONE, undefined, w.l1.head - 5n)
    w.sweep(sipa, 8n, { block: w.l1.head })

    const { claimed } = await w.pass()

    expect(claimed.claimed).toBe(1)
    expect(w.l2.claims.map((c) => c.inboxIndex)).toEqual([8n])
    expect(await w.get(sipa.address)).toMatchObject({ claimedInboxIndexes: ["7", "8"] })
  })

  it("writes nothing for a quiet settled SIPA but its cursor", async () => {
    const w = await pipelineWorld()
    await setCursor(w, w.l1.head - 1n)
    const sipa = await observed(w, 1, {
      phase: "claimed",
      claimedInboxIndexes: ["7"],
      endTime: 1,
      amount: "0.9",
      fee: FEE.toString(),
      inboxIndex: "7",
      heldBalance: "0",
    })
    // The first pass backfills what discovery derives; the next has nothing to write.
    await w.scan()
    const before = await w.get(sipa.address)
    const writes: string[] = []
    w.db.onCommit((ops) => writes.push(...ops.map(([key]) => key)))
    w.l1.head += 1n

    await w.scan()

    expect(await w.get(sipa.address)).toEqual(before)
    expect(writes).toEqual([sipaCursorKey(PORTAL, RECIPIENT.toString())])
  })

  it("keeps an unsettled sweep's claim inputs, and claims it once a later pass no longer sees it", async () => {
    const w = await pipelineWorld()
    const sipa = await w.announced(1)
    w.pay(sipa.address, ONE, undefined, w.l1.head - 5_010n)
    const { key, tx } = w.sweep(sipa, 7n, { block: w.l1.head - 5_000n })
    await w.scan()
    expect(await w.get(sipa.address)).toMatchObject({
      phase: "pendingClaim",
      pendingSweeps: [
        {
          inboxIndex: "7",
          amount: (ONE - FEE).toString(),
          messageKey: key,
          blockNumber: (w.l1.head - 5_000n).toString(),
          sweepTxHash: tx,
        },
      ],
    })
    w.l1.head += 10_000n
    await w.scan()

    w.l2.settle(key)
    await w.claim()

    const record = (await w.get(sipa.address))!
    expect(record).toMatchObject({
      phase: "claimed",
      claimedInboxIndexes: ["7"],
      sweeps: [expect.objectContaining({ inboxIndex: "7", messageKey: key })],
    })
    expect(record.pendingSweeps).toBeUndefined()
  })

  it("claims a pending sweep at the fee saved for it, though the row was repriced since", async () => {
    const w = await pipelineWorld()
    const sipa = await w.announced(1)
    w.pay(sipa.address, ONE)
    const { key } = w.sweep(sipa, 7n)
    await w.scan()
    expect(await w.get(sipa.address)).toMatchObject({ phase: "pendingClaim", fee: FEE.toString() })
    w.l1.row(DAI_ROW.token.address, 1, { portal: PORTAL, sweepTip: 2n * FEE })
    w.l1.head += 1n
    await w.scan()

    w.l2.settle(key)
    await w.claim()

    expect(await w.get(sipa.address)).toMatchObject({
      phase: "claimed",
      fee: FEE.toString(),
      sweeps: [expect.objectContaining({ inboxIndex: "7", fee: FEE.toString() })],
    })
  })

  it("claims a sweep both observed again and already pending once", async () => {
    const w = await pipelineWorld()
    const sipa = await w.announced(1)
    w.pay(sipa.address, ONE)
    w.sweep(sipa, 7n)
    await w.scan()
    w.l1.head += 1n

    await w.pass()

    expect(w.l2.claims).toHaveLength(1)
  })

  it("keeps a sweep whose claim failed for the next run", async () => {
    const w = await pipelineWorld()
    const sipa = await w.announced(1)
    w.pay(sipa.address, ONE)
    w.sweep(sipa, 7n)
    w.l2.claimError = () => new Error("pxe busy")

    const { claimed } = await w.pass()

    expect(claimed).toMatchObject({ claimed: 0, failed: 1 })
    expect((await w.get(sipa.address))?.pendingSweeps).toEqual([
      expect.objectContaining({ inboxIndex: "7" }),
    ])
  })

  it("re-reads a SIPA from the window a failed pass missed, while the cursor moves on", async () => {
    const w = await pipelineWorld()
    await setCursor(w, w.l1.head - 1n)
    const sipa = await observed(w, 1, { rescanFrom: (w.l1.head - 600n).toString() })

    await w.scan()

    // The saved bound already holds the overlap.
    expect(ranges(w)).toEqual([[w.l1.head - 600n, w.l1.head]])
    expect((await w.get(sipa.address))?.rescanFrom).toBeUndefined()
  })

  it("leaves a SIPA whose scan threw to re-read from its window", async () => {
    const w = await pipelineWorld()
    await setCursor(w, w.l1.head - 1n)
    const sipa = await observed(w, 1)
    // No balance reads: the funding probe cannot tell the address is empty, and throws.
    w.l1.failing = (c) =>
      c.fn === "aggregate3" || c.fn === "balanceOf" || c.method === "eth_getBalance"

    expect(await w.scan()).toMatchObject({ failed: 1 })
    expect(await w.get(sipa.address)).toMatchObject({
      rescanFrom: (w.l1.head - 1n - OVERLAP).toString(),
    })
    expect(await w.cursor()).toBe(w.l1.head)
  })

  it("leaves a record whose plan failed the window this pass would have read", async () => {
    const w = await pipelineWorld()
    await setCursor(w, w.l1.head - 1n)
    const sipa = await w.derive(salt(1))
    await w.saved(sipa, {
      phase: "broadcast",
      intent: "registration",
      observedFrom: (w.l1.head - 1_000n).toString(),
    })
    w.l1.implementations.delete(2)

    expect(await w.scan()).toMatchObject({ failed: 1 })
    expect(await w.get(sipa.address)).toMatchObject({
      rescanFrom: (w.l1.head - 1n - OVERLAP).toString(),
    })
    expect(await w.cursor()).toBe(w.l1.head)
  })

  it("keeps an observed record's window when a new record falls back to the look-back", async () => {
    const w = await pipelineWorld()
    await setCursor(w, w.l1.head - 200_000n)
    await observed(w, 2)
    await w.announced(1)

    await w.scan({
      historyStartBlock: async () => {
        throw new Error("rpc down")
      },
    })

    expect(
      ranges(w)
        .map(([from]) => from)
        .sort(),
    ).toEqual([w.l1.head - 200_000n - OVERLAP, w.l1.head - 50_000n].sort())
  })

  it("drops a saved sweep the window covers and no longer shows: reorged away", async () => {
    const w = await pipelineWorld()
    await setCursor(w, w.l1.head - 1n)
    const sipa = await observed(w, 1, {
      phase: "pendingClaim",
      pendingSweeps: [
        {
          inboxIndex: "7",
          amount: "990000",
          messageKey: `0x${"0a".repeat(32)}`,
          blockNumber: (w.l1.head - 10n).toString(),
          sweepTxHash: `0x${"5e".repeat(32)}`,
        },
      ],
    })
    w.pay(sipa.address, ONE)

    await w.pass()

    expect(w.l2.claims).toEqual([])
    const record = (await w.get(sipa.address))!
    expect(record.pendingSweeps).toBeUndefined()
    expect(record.phase).toBe("sweeping")
  })

  it("reads an address as unfunded when a reorg drops its only sweep and its funding", async () => {
    const w = await pipelineWorld()
    const sipa = await w.announced(1)
    const funding = w.pay(sipa.address, ONE)
    const { tx } = w.sweep(sipa, 7n)
    await w.scan()
    expect(arriving(await w.records())).toBe(ONE - FEE)

    w.l1.reorg(funding)
    w.l1.reorg(tx)
    await w.scan()

    const record = (await w.get(sipa.address))!
    expect(record.phase).toBe("broadcast")
    expect(record.pendingSweeps).toBeUndefined()
    expect(isUnfundedSipaDeposit(record)).toBe(true)
    expect(arriving(await w.records())).toBe(0n)
  })

  it.each([
    { held: false, phase: "claimed" },
    { held: true, phase: "sweeping" },
  ])(
    "leaves pendingClaim when a reorg drops a second sweep (held: $held)",
    async ({ held, phase }) => {
      const w = await pipelineWorld()
      const sipa = await w.announced(1)
      w.pay(sipa.address, ONE, undefined, w.l1.head - 70n)
      w.sweep(sipa, 7n, { block: w.l1.head - 60n })
      await w.pass()
      w.pay(sipa.address, ONE)
      const { tx } = w.sweep(sipa, 9n)
      await w.scan()
      expect(await w.get(sipa.address)).toMatchObject({ phase: "pendingClaim" })
      expect(arriving(await w.records())).toBe(ONE - FEE)

      w.l1.reorg(tx)
      if (held) w.l1.setBalance(sipa.address, DAI, ONE)
      await w.scan()

      const record = (await w.get(sipa.address))!
      expect(record.phase).toBe(phase)
      expect(record.pendingSweeps).toBeUndefined()
      expect(arriving(await w.records())).toBe(0n)
      // The feed row reads the last real sweep, not the reorged one.
      const [first] = record.sweeps!
      expect(record).toMatchObject({
        inboxIndex: "7",
        netAmount: first!.netAmount,
        sweepTxHash: first!.sweepTxHash,
        amount: formatUnits(BigInt(first!.netAmount), first!.tokenDecimals!),
      })
    },
  )

  it("keeps a delayed sweep's gross and token with its claim inputs, for a claim past its window", async () => {
    const w = await pipelineWorld()
    const sipa = await w.announced(1)
    w.pay(sipa.address, 5_000_000n, USDC, w.l1.head - 5_010n)
    const { key } = w.l1.sweep({
      sipa: sipa.address,
      token: USDC,
      gross: 5_000_000n,
      credit: 4n * ONE,
      index: 7n,
      commitment: sipa.commitment,
      portal: PORTAL,
      block: w.l1.head - 5_000n,
    })
    await w.scan()
    expect((await w.get(sipa.address))?.pendingSweeps).toEqual([
      expect.objectContaining({ grossAmount: "5000000", fundingToken: USDC }),
    ])
    w.l1.head += 10_000n
    await w.scan()

    w.l2.settle(key)
    await w.claim()

    expect((await w.get(sipa.address))?.sweeps).toEqual([
      expect.objectContaining({
        inboxIndex: "7",
        grossAmount: "5000000",
        fundingTokenSymbol: "USDC",
      }),
    ])
  })

  it("commits its records with the cursor, and neither when the commit does not land", async () => {
    const w = await pipelineWorld()
    const sipa = await w.announced(1)
    w.pay(sipa.address, ONE)
    w.sweep(sipa, 7n)
    const write = w.db.write
    w.db.write = async () => {
      throw new Error("quota exceeded")
    }

    expect(await w.scan()).toMatchObject({ complete: false })
    w.db.write = write
    expect(await w.records()).toEqual([])
    expect(await w.cursor()).toBeUndefined()

    await w.scan()
    expect(await w.get(sipa.address)).toMatchObject({ phase: "pendingClaim" })
    expect(await w.cursor()).toBe(w.l1.head)
  })

  it("dates a sweep's ledger entry at its block", async () => {
    const w = await pipelineWorld()
    const sipa = await w.announced(1)
    w.pay(sipa.address, ONE)
    const block = w.l1.head - 40n
    w.l1.emit(
      USDC,
      erc20Abi as Abi,
      "Transfer",
      { from: sipa.address, to: PORTAL, value: 0n },
      {
        tx: w.l1.tx(),
        block,
      },
    )
    w.sweep(sipa, 7n, { block })

    await w.pass()

    expect((await w.get(sipa.address))?.sweeps).toEqual([
      expect.objectContaining({
        settledAt: Number(w.l1.timeOf(block)) * 1000,
        grossAmount: ONE.toString(),
        fundingTokenSymbol: "DAI",
      }),
    ])
  })
})

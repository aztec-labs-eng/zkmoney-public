// @vitest-environment node
/** A table of two rows: each sweep settles, prices and claims on its own row. */
import { describe, expect, it, vi } from "vitest"
import { formatUnits, type Address } from "viem"
import { sipaCredits } from "../../../src/core/services/deposits/sipaCredits"
import { savingsValue } from "../../../src/core/services/savings/savingsMath"
import { arrivingFunds } from "../../../src/engine/activityFeed"
import { selectHomeMain, type BalanceView } from "../../../src/engine/balances"
import { sipaCursorKey } from "../../../src/engine/sipaDeposits"
import {
  DAI,
  DAI_ROW,
  FEE,
  L2_TOKEN,
  PORTAL,
  RECIPIENT,
  SAVINGS_L2_TOKEN,
  SAVINGS_PORTAL,
  SAVINGS_ROW,
  SUSDS,
  USDC,
  pipelineWorld,
  salt,
} from "./world"

const SAVINGS_FEE = 10n ** 16n
const ONE = 10n ** 18n

async function twoRows() {
  const w = await pipelineWorld([DAI_ROW, SAVINGS_ROW])
  w.l1.row(SUSDS, 1, { portal: SAVINGS_PORTAL, sweepTip: SAVINGS_FEE })
  return w
}

/** One address funded in both rows' tokens and swept on each: DAI at inbox 7, sUSDS at 8. */
async function bothSwept(w: Awaited<ReturnType<typeof twoRows>>) {
  const sipa = await w.announced(1)
  w.pay(sipa.address, ONE)
  w.pay(sipa.address, 5n * ONE, SUSDS)
  const dai = w.sweep(sipa, 7n)
  const susds = w.sweep(sipa, 8n, { t: SUSDS, row: SAVINGS_ROW, credit: 5n * ONE - SAVINGS_FEE })
  return { sipa, dai, susds }
}

const capDown = (w: Awaited<ReturnType<typeof twoRows>>) => {
  w.l1.failing = (c) => c.fn === "TX_AMOUNT_CAP" && c.to === SAVINGS_PORTAL.toLowerCase()
}

describe("across two rows", () => {
  it("looks up each row's spent sweeps on that row's L2 token", async () => {
    const w = await twoRows()
    const { susds } = await bothSwept(w)
    w.l2.spend(SAVINGS_L2_TOKEN, susds.key)

    const { claimed } = await w.pass()

    expect(claimed).toMatchObject({ claimed: 1, reconciled: 1, failed: 0 })
    expect(w.l2.claims.map((c) => c.inboxIndex)).toEqual([7n])
  })

  it("reads a row's history afresh while its portal has no cursor, and then moves every row's", async () => {
    const w = await twoRows()
    const sipa = await w.derive(salt(1))
    await w.saved(sipa, { observedFrom: (w.l1.head - 1_000n).toString() })
    await w.db.write(async (tx) =>
      tx.put(sipaCursorKey(PORTAL, RECIPIENT.toString()), String(w.l1.head - 10n)),
    )
    const historyStartBlock = vi.fn(async () => 5n)

    await w.scan({ historyStartBlock })

    expect(historyStartBlock).toHaveBeenCalled()
    expect(await w.cursor(PORTAL)).toBe(w.l1.head)
    expect(await w.cursor(SAVINGS_PORTAL)).toBe(w.l1.head)
  })

  it("gives a new row's portal no cursor while its history start fails, so the next pass reads it again", async () => {
    const w = await twoRows()
    const sipa = await w.derive(salt(1))
    await w.saved(sipa, { observedFrom: (w.l1.head - 1_000n).toString() })
    await w.db.write(async (tx) =>
      tx.put(sipaCursorKey(PORTAL, RECIPIENT.toString()), String(w.l1.head - 10n)),
    )

    await w.scan({
      historyStartBlock: async () => {
        throw new Error("rpc down")
      },
    })
    expect(await w.cursor(PORTAL)).toBe(w.l1.head)
    expect(await w.cursor(SAVINGS_PORTAL)).toBeUndefined()

    const historyStartBlock = vi.fn(async () => 5n)
    await w.scan({ historyStartBlock })
    expect(historyStartBlock).toHaveBeenCalled()
    expect(await w.cursor(SAVINGS_PORTAL)).toBe(w.l1.head)
  })

  it("claims each sweep of one address through its own row's token, and ledgers both", async () => {
    const w = await twoRows()
    const { sipa } = await bothSwept(w)

    const { scanned, claimed } = await w.pass()

    expect(scanned).toMatchObject({ discovered: 1, failed: 0 })
    expect(claimed).toMatchObject({ claimed: 2, failed: 0 })
    expect(w.l2.claims.map((c) => [c.l2Token, c.inboxIndex, c.amount])).toEqual([
      [DAI_ROW.l2Token, 7n, ONE - FEE],
      [SAVINGS_L2_TOKEN, 8n, 5n * ONE - SAVINGS_FEE],
    ])
    const record = (await w.get(sipa.address))!
    expect(record.sweeps).toEqual([
      expect.objectContaining({
        inboxIndex: "7",
        portal: PORTAL,
        l2Token: DAI_ROW.l2Token,
        tokenAddress: DAI,
        tokenSymbol: "DAI",
        tokenDecimals: 18,
        fee: FEE.toString(),
        netAmount: (ONE - FEE).toString(),
      }),
      expect.objectContaining({
        inboxIndex: "8",
        portal: SAVINGS_PORTAL,
        l2Token: SAVINGS_L2_TOKEN,
        tokenAddress: SUSDS,
        tokenSymbol: "sUSDS",
        fee: SAVINGS_FEE.toString(),
        netAmount: (5n * ONE - SAVINGS_FEE).toString(),
      }),
    ])
    // The record reads as its latest sweep, in that row's token and units.
    expect(record).toMatchObject({
      phase: "claimed",
      claimedInboxIndexes: ["7", "8"],
      tokenSymbol: "sUSDS",
      fee: SAVINGS_FEE.toString(),
    })
  })

  it("reads as its claimed DAI sweep when a reorg drops a pending sUSDS sweep", async () => {
    const w = await twoRows()
    const sipa = await w.announced(1)
    w.pay(sipa.address, ONE, DAI, w.l1.head - 70n)
    w.sweep(sipa, 7n, { block: w.l1.head - 60n })
    await w.pass()
    w.pay(sipa.address, 5n * ONE, SUSDS)
    const { tx } = w.sweep(sipa, 8n, { t: SUSDS, row: SAVINGS_ROW, credit: 5n * ONE - SAVINGS_FEE })
    await w.scan()
    expect(await w.get(sipa.address)).toMatchObject({ phase: "pendingClaim", tokenAddress: SUSDS })

    w.l1.reorg(tx)
    await w.scan()

    const record = (await w.get(sipa.address))!
    expect(record).toMatchObject({
      phase: "claimed",
      inboxIndex: "7",
      tokenAddress: DAI,
      tokenSymbol: "DAI",
      netAmount: (ONE - FEE).toString(),
      amount: formatUnits(ONE - FEE, 18),
      fee: FEE.toString(),
    })
    expect(sipaCredits(record).map((c) => [c.record.tokenAddress, c.record.inboxIndex])).toEqual([
      [DAI, "7"],
    ])
  })

  it("rebuilds both credited deposits on a fresh device from the event on either row's token", async () => {
    const w = await twoRows()
    const { sipa } = await bothSwept(w)
    // A resolver broadcast notifies each row's L2 token, so both carry the one event.
    w.l2.emit(SAVINGS_L2_TOKEN, RECIPIENT, { salt: sipa.salt, intentHash: sipa.intentHash })

    const { scanned, claimed } = await w.pass()

    expect(w.l2.eventReads).toBe(2)
    expect(scanned.discovered).toBe(1)
    expect(claimed.claimed).toBe(2)
    expect((await w.get(sipa.address))!.sweeps!.map((s) => s.tokenSymbol)).toEqual(["DAI", "sUSDS"])
  })

  it("prices a balance on its own row though another row cannot be priced", async () => {
    const w = await twoRows()
    capDown(w)
    const sipa = await w.announced(1)
    w.pay(sipa.address, ONE)

    await w.scan()

    expect(await w.get(sipa.address)).toMatchObject({
      phase: "sweeping",
      tokenSymbol: "DAI",
      fee: FEE.toString(),
    })
  })

  it("drops a fee priced on another row when new funds sit on an unpriced row", async () => {
    const w = await twoRows()
    capDown(w)
    const sipa = await w.announced(1)
    await w.saved(sipa, {
      phase: "claimed",
      tokenSymbol: "DAI",
      fee: FEE.toString(),
      netAmount: "900",
      inboxIndex: "7",
      claimedInboxIndexes: ["7"],
      endTime: 1,
    })
    w.pay(sipa.address, 2n * ONE, SUSDS)

    await w.scan()

    const record = (await w.get(sipa.address))!
    expect(record).toMatchObject({ tokenSymbol: "sUSDS", tokenDecimals: 18 })
    expect(record.fee).toBeUndefined()
  })

  it("drops a fee priced on another row when the sweep lands on a row it cannot price", async () => {
    const w = await twoRows()
    w.l1.rows.delete(`${SUSDS.toLowerCase()}:1`)
    const sipa = await w.announced(1)
    await w.saved(sipa, { phase: "sweeping", tokenSymbol: "DAI", fee: FEE.toString(), amount: "1" })
    w.pay(sipa.address, 5n * ONE, SUSDS)
    w.sweep(sipa, 8n, { t: SUSDS, row: SAVINGS_ROW, credit: 5n * ONE - SAVINGS_FEE })

    await w.pass()

    expect(w.l2.claims.map((c) => c.l2Token)).toEqual([SAVINGS_L2_TOKEN])
    const record = (await w.get(sipa.address))!
    expect(record).toMatchObject({ phase: "claimed", tokenSymbol: "sUSDS" })
    expect(record.fee).toBeUndefined()
    expect(record.sweeps![0]!.fee).toBeUndefined()
  })

  it("reads a SIPA whose intent no row prices, holding it unpriced", async () => {
    const w = await pipelineWorld([{ ...DAI_ROW, intents: ["deposit"] }])
    const sipa = await w.derive(salt(1))
    await w.saved(sipa, { phase: "broadcast", intent: "registration" })
    w.pay(sipa.address, ONE)

    const result = await w.scan()

    expect(result.failed).toBe(0)
    const record = (await w.get(sipa.address))!
    expect(record).toMatchObject({ phase: "broadcast", tokenSymbol: "DAI" })
    expect(record.fee).toBeUndefined()
  })

  it("names the row a swapped balance settles in", async () => {
    const w = await pipelineWorld()
    const sipa = await w.announced(1)
    w.pay(sipa.address, 5_000_000n, USDC)

    await w.scan()

    expect(await w.get(sipa.address)).toMatchObject({ tokenAddress: USDC, rowToken: DAI })
  })

  it("holds a registration's balance to the rows it settles on, so sUSDS alone does not fund it", async () => {
    const w = await twoRows()
    const sipa = await w.derive(salt(1))
    await w.saved(sipa, { phase: "broadcast", intent: "registration" })
    w.pay(sipa.address, 2n * ONE, SUSDS)

    await w.scan()

    expect((await w.get(sipa.address))?.heldBalance).toBe("0")
  })

  it.each([
    ["DAI first", [DAI, SUSDS] as const],
    ["sUSDS first", [SUSDS, DAI] as const],
  ])("prices each sweep on its own row whichever funding is seen first (%s)", async (_, order) => {
    const w = await twoRows()
    const [first, second] = order as readonly [Address, Address]
    const sipa = await w.announced(1)
    // Pass 1: only the first token has arrived; the probe prices it on its row.
    w.pay(sipa.address, ONE, first)
    await w.scan()
    expect(await w.get(sipa.address)).toMatchObject({
      tokenAddress: first,
      fee: (first === SUSDS ? SAVINGS_FEE : FEE).toString(),
    })
    // Pass 2: the second token arrives and both are swept.
    w.l1.head += 100n
    w.pay(sipa.address, ONE, second, w.l1.head - 50n)
    w.sweep(sipa, 7n, { block: w.l1.head - 40n })
    w.sweep(sipa, 8n, {
      t: SUSDS,
      row: SAVINGS_ROW,
      block: w.l1.head - 40n,
      credit: ONE - SAVINGS_FEE,
    })
    await w.pass()

    const record = (await w.get(sipa.address))!
    const fees = Object.fromEntries(record.sweeps!.map((s) => [s.tokenSymbol, s.fee]))
    expect(fees).toEqual({ DAI: FEE.toString(), sUSDS: SAVINGS_FEE.toString() })
    const latest = record.sweeps!.find((s) => s.inboxIndex === record.inboxIndex)!
    expect(record.fee).toBe(latest.fee)
  })

  it("prices an unswept SIPA on the row of the token it holds, reading each row's cap once", async () => {
    const w = await twoRows()
    const sipa = await w.announced(1)
    w.pay(sipa.address, 2n * ONE, SUSDS)

    await w.scan()

    expect(await w.get(sipa.address)).toMatchObject({
      phase: "sweeping",
      tokenSymbol: "sUSDS",
      tokenDecimals: 18,
      amount: "2",
      fee: SAVINGS_FEE.toString(),
    })
    // Per row: one fee read, which reads its portal's cap, and one cap read for the window.
    expect(w.l1.count({ fn: "rowFor" })).toBe(2)
    expect(w.l1.count({ fn: "TX_AMOUNT_CAP" })).toBe(4)
  })
})

describe("a recovered wallet's arriving deposits", () => {
  const PRICE = (11n * ONE) / 10n

  /** Home's figures: what the claims landed on each row's token, plus what is on its way. */
  const figures = async (w: Awaited<ReturnType<typeof twoRows>>, savingsUnknown = false) => {
    const held = (l2Token: string) =>
      w.l2.claims.filter((c) => c.l2Token === l2Token).reduce((sum, c) => sum + c.amount, 0n)
    const arriving = arrivingFunds({
      deposits: await w.records(),
      burns: [],
      moves: [],
      rows: [],
      ...(savingsUnknown ? { savingsUnknown } : { savingsToken: SUSDS, sharePrice: PRICE }),
    })
    const view = { main: { atomic: held(L2_TOKEN) }, known: true } as BalanceView
    const main = selectHomeMain(view, {
      arriving: arriving.main,
      lock: { checked: true, held: false },
      upgradesLoaded: true,
    }).shown
    return {
      arriving,
      main,
      savings: savingsValue(held(SAVINGS_L2_TOKEN), PRICE) + arriving.savings,
    }
  }

  it("holds a swept sUSDS deposit until Savings' row is known, and Main never dips", async () => {
    const w = await twoRows()
    const susds = await w.announced(2)
    w.pay(susds.address, 5n * ONE, SUSDS)
    const shares = 5n * ONE - SAVINGS_FEE
    w.sweep(susds, 8n, { t: SUSDS, row: SAVINGS_ROW, credit: shares })
    await w.scan()

    const unknown = await figures(w, true)
    expect(unknown.arriving).toEqual({ main: 0n, savings: 0n })
    const known = await figures(w)
    expect(known.arriving).toEqual({ main: 0n, savings: savingsValue(shares, PRICE) })
    expect(known.main).toBe(unknown.main)

    for (const r of await w.records())
      for (const s of r.pendingSweeps ?? []) w.l2.settle(s.messageKey)
    await w.claim()
    const claimed = await figures(w)
    expect(claimed.main).toBe(known.main)
    expect(claimed.savings).toBe(known.savings)
  })

  it("counts a replayed sUSDS deposit in Savings at the share price, so Main never drops", async () => {
    const w = await twoRows()
    const dai = await w.announced(1)
    const susds = await w.announced(2)
    w.pay(dai.address, ONE)
    w.pay(susds.address, 5n * ONE, SUSDS)
    w.sweep(dai, 7n)
    const shares = 5n * ONE - SAVINGS_FEE
    w.sweep(susds, 8n, { t: SUSDS, row: SAVINGS_ROW, credit: shares })
    await w.scan()

    const before = await figures(w)
    expect(before.arriving).toEqual({ main: ONE - FEE, savings: savingsValue(shares, PRICE) })

    for (const r of await w.records())
      for (const s of r.pendingSweeps ?? []) w.l2.settle(s.messageKey)
    expect(await w.claim()).toMatchObject({ claimed: 2, failed: 0 })

    const after = await figures(w)
    expect(after.arriving).toEqual({ main: 0n, savings: 0n })
    expect({ main: after.main, savings: after.savings }).toEqual({
      main: before.main,
      savings: before.savings,
    })
  })
})

/** Each payment to an address paid more than once, and the request links at it. */
import { describe, expect, it } from "vitest"
import type { FeedItem } from "../../src/engine/activityFeed"
import type { SipaDeposit } from "../../src/engine/sipaDeposits"
import {
  bridgeDetailTarget,
  depositDetailId,
  depositDetailItem,
  findBridgeItem,
} from "../../src/engine/feedRules"
import { resolveRequests } from "../../src/engine/requests"
import { addr, deposit, E18, feedOf, HOUR, kinds, NOW, request, tx } from "./feedFixtures"

describe("a past payment split out of its record", () => {
  it("splits a past payment in another token into a row of its own, under its address's one tag purchase", () => {
    const record = deposit({
      tokenAddress: addr("a1"),
      inboxIndex: "8",
      registrationFee: (3n * E18).toString(),
      sweeps: [
        { tokenAddress: addr("b2"), netAmount: "4000000", tokenDecimals: 6, inboxIndex: "7" },
      ],
    } as never)
    const feed = feedOf(
      { deposits: [record] },
      {
        registrations: {
          records: [{ sipaAddress: record.sipaAddress, tag: "ada", phase: "confirmed" } as never],
        },
      },
    )
    const ids = kinds(feed.items)
    expect(ids).toContain(`deposit:${record.sipaAddress}:7`)
    expect(ids.filter((id) => id.startsWith("tagPurchase:"))).toHaveLength(1)
    const past = feed.items.find((i) => i.id.endsWith(":7"))
    expect(past).toMatchObject({ payment: "7", record: { phase: "claimed", amount: "4" } })
    // The tag's price came out of the first payment, and its sheet opens on it.
    const purchase = feed.items.find(
      (i): i is Extract<FeedItem, { kind: "tagPurchase" }> => i.kind === "tagPurchase",
    )!
    expect(purchase).toMatchObject({ record: { inboxIndex: "7" } })
    const opened = depositDetailItem(feed.bridge, depositDetailId(purchase))
    expect(opened?.record).toMatchObject({ inboxIndex: "7", amount: "4" })
  })

  it("opens each payment's row on that payment's detail, and keeps it when the address is paid again", () => {
    const DAI = addr("da")
    const SUSDS = addr("5d")
    const sweep = (inboxIndex: string, tokenAddress: string, tokenSymbol: string, net: bigint) => ({
      inboxIndex,
      sweepTxHash: `0x${inboxIndex.repeat(64)}`,
      netAmount: net.toString(),
      tokenAddress,
      tokenSymbol,
      tokenDecimals: 18,
    })
    const twice = deposit({
      tokenAddress: SUSDS,
      tokenSymbol: "sUSDS",
      tokenDecimals: 18,
      amount: "2",
      netAmount: (2n * E18).toString(),
      inboxIndex: "8",
      sweeps: [sweep("7", DAI, "DAI", 5n * E18), sweep("8", SUSDS, "sUSDS", 2n * E18)],
    } as never)
    const feed = feedOf({ deposits: [twice] })
    const rows = feed.items.flatMap((i) => (i.kind === "deposit" ? [i] : []))
    const opened = rows.map((row) => depositDetailItem(feed.bridge, depositDetailId(row))?.record)
    expect(opened.map((r) => [r?.tokenSymbol, r?.amount]).sort()).toEqual([
      ["DAI", "5"],
      ["sUSDS", "2"],
    ])

    const ids = rows.map(depositDetailId)
    const later = deposit({
      ...twice,
      tokenAddress: DAI,
      tokenSymbol: "DAI",
      amount: "3",
      netAmount: (3n * E18).toString(),
      inboxIndex: "9",
      sweeps: [...(twice.sweeps ?? []), sweep("9", DAI, "DAI", 3n * E18)],
    } as never)
    const bridge = feedOf({ deposits: [later] }).bridge
    const reopened = ids.map((id) => depositDetailItem(bridge, id)?.record)
    expect(reopened.map((r) => [r?.tokenSymbol, r?.amount]).sort()).toEqual([
      ["DAI", "5"],
      ["sUSDS", "2"],
    ])
    expect(depositDetailItem(bridge, twice.sipaAddress)?.record.amount).toBe("3")
  })
})

describe("an address paid twice", () => {
  const SIPA = addr("5a")
  const DAI = addr("da")
  const FIRST_AT = NOW - 5 * HOUR
  const SECOND_AT = NOW - HOUR
  const sweep = (inboxIndex: string, net: bigint, settledAt: number) => ({
    inboxIndex,
    sweepTxHash: `0x${inboxIndex.repeat(64)}`,
    netAmount: net.toString(),
    fee: (E18 / 4n).toString(),
    settledAt,
    tokenAddress: DAI,
    tokenSymbol: "DAI",
    tokenDecimals: 18,
  })
  const NET_1 = (975n * E18) / 100n
  const NET_2 = (675n * E18) / 100n
  const first = sweep("7", NET_1, FIRST_AT)
  const second = sweep("8", NET_2, SECOND_AT)
  // 10 DAI in, 9.75 credited.
  const once = deposit({
    sipaAddress: SIPA,
    tokenAddress: DAI,
    tokenSymbol: "DAI",
    tokenDecimals: 18,
    amount: "9.75",
    netAmount: first.netAmount,
    fee: first.fee,
    inboxIndex: "7",
    claimedInboxIndexes: ["7"],
    sweepTxHash: first.sweepTxHash,
    sweeps: [first],
    startTime: FIRST_AT - 60_000,
    endTime: FIRST_AT,
  } as never)
  // 7 DAI in again: the record reopened on the new payment, whose sweep is not seen yet.
  const paidAgain = deposit({
    ...once,
    phase: "sweeping",
    amount: "7",
    netAmount: undefined,
    sweepTxHash: undefined,
    startTime: SECOND_AT - 60_000,
    endTime: undefined,
  } as never)
  // 0.05 DAI in again, under the sweep fee: never swept.
  const tooSmall = deposit({ ...paidAgain, phase: "recoverable", amount: "0.05" } as never)
  const swept = deposit({
    ...paidAgain,
    phase: "pendingClaim",
    amount: "6.75",
    netAmount: second.netAmount,
    inboxIndex: "8",
    sweepTxHash: second.sweepTxHash,
  } as never)
  const twice = deposit({
    ...swept,
    phase: "claimed",
    claimedInboxIndexes: ["7", "8"],
    sweeps: [first, second],
    endTime: SECOND_AT + 1_000,
  } as never)
  // A reorg dropped the second sweep: the record reads as its claimed one, sweeping what it holds.
  const reorged = deposit({
    ...swept,
    phase: "sweeping",
    amount: "9.75",
    netAmount: first.netAmount,
    inboxIndex: "7",
    sweepTxHash: first.sweepTxHash,
  } as never)
  // As a fresh device replays it: dated by the first funding, ended at the last sweep, its funding
  // read as a plain transfer rather than a bridge-in.
  const replayed = deposit({
    ...twice,
    startTime: FIRST_AT - 60_000,
    endTime: SECOND_AT,
    replayed: true,
    fundingTxHash: `0x${"f1".repeat(32)}`,
    funding: "transfer",
  } as never)

  const rows = (record: SipaDeposit) =>
    feedOf({ deposits: [record] }).items.flatMap((i) =>
      i.kind === "deposit" ? [[i.id, i.record.amount, i.pending]] : [],
    )

  it("keeps the first payment's row through the second's sweep and claim", () => {
    expect(rows(once)).toEqual([[SIPA, "9.75", false]])
    expect(rows(paidAgain)).toEqual([
      [SIPA, "7", true],
      [`${SIPA}:7`, "9.75", false],
    ])
    expect(rows(swept)).toEqual([
      [SIPA, "6.75", true],
      [`${SIPA}:7`, "9.75", false],
    ])
    expect(rows(twice)).toEqual([
      [SIPA, "6.75", false],
      [`${SIPA}:7`, "9.75", false],
    ])
  })

  it("rebuilds both rows on a fresh device, each at its own sweep", () => {
    const items = feedOf({ deposits: [replayed] }).items
    expect(items.map((i) => [i.id, i.ts])).toEqual([
      [SIPA, SECOND_AT],
      [`${SIPA}:7`, FIRST_AT],
    ])
    expect(rows(replayed)).toEqual(rows(twice))
  })

  it("counts only the payment on its way in as arriving", () => {
    expect(feedOf({ deposits: [paidAgain] }).arriving.main).toBe(0n)
    expect(feedOf({ deposits: [swept] }).arriving.main).toBe(NET_2)
    expect(feedOf({ deposits: [twice] }).arriving.main).toBe(0n)
  })

  it("opens a past payment's detail from its row and from the bell", () => {
    const feed = feedOf({ deposits: [twice] })
    const past = feed.items.find((i): i is Extract<FeedItem, { kind: "deposit" }> =>
      i.id.endsWith(":7"),
    )!
    expect(depositDetailItem(feed.bridge, depositDetailId(past))?.record.amount).toBe("9.75")
    const hit = findBridgeItem(feed.bridge, { openDepositAddress: `${SIPA.toLowerCase()}:7` })!
    const target = bridgeDetailTarget(hit) as { address: string }
    expect(depositDetailItem(feed.bridge, target.address)?.record.amount).toBe("9.75")
    expect(findBridgeItem(feed.bridge, { openDepositAddress: SIPA })?.record.amount).toBe("6.75")
  })

  it("shows a paid link as the payment that paid it, and a later payment there as a deposit", () => {
    const link = request({
      id: "link",
      direction: "outgoing",
      kind: "link",
      contactTag: "",
      sipaAddress: SIPA,
      amountAtomic: (9n * E18).toString(),
    })
    const code = { ...link, unlisted: true, amountAtomic: "0" }
    for (const stored of [link, code]) {
      for (const record of [paidAgain, tooSmall, reorged, twice]) {
        const requests = resolveRequests([stored as never], { rows: [], deposits: [record] })
        const items = feedOf({ requests, deposits: [record] }).items
        expect(items.map((i) => `${i.kind}:${i.id}`)).toEqual([`deposit:${SIPA}`, "paidLink:link"])
        expect(items[1]).toMatchObject({ amount: { atomic: NET_1 }, ts: FIRST_AT })
      }
    }
  })

  it("lists a later payment to an edited link's address as a deposit", () => {
    const link = { direction: "outgoing", kind: "link", contactTag: "", sipaAddress: SIPA } as const
    // The edit cancelled the link it replaced, at the same address; neither payment fits that one.
    const replaced = request({
      ...link,
      id: "old",
      status: "cancelled",
      amountAtomic: (20n * E18).toString(),
      createdAt: NOW - 7 * HOUR,
    })
    const edited = request({ ...link, id: "new", amountAtomic: (9n * E18).toString() })
    const requests = resolveRequests([replaced, edited] as never, { rows: [], deposits: [twice] })
    expect(kinds(feedOf({ requests, deposits: [twice] }).items)).toEqual([
      `deposit:${SIPA}`,
      "paidLink:new",
    ])
  })

  it("shows a link paid before payments were read as the payment it holds, a later one as a deposit", () => {
    const link = request({
      id: "link",
      direction: "outgoing",
      kind: "link",
      contactTag: "",
      sipaAddress: SIPA,
      status: "paid" as never,
      fulfillmentTxHash: "0xclaim",
    })
    const requests = resolveRequests([link as never], { rows: [], deposits: [twice] })
    expect(requests[0].paidByDeposit).toEqual({ sipaAddress: SIPA, inboxIndex: "7" })
    expect(kinds(feedOf({ requests, deposits: [twice] }).items)).toEqual([
      `deposit:${SIPA}`,
      "paidLink:link",
    ])
  })

  it("lists an external wallet's payment to an imported link paid in-app as a deposit", () => {
    // Imported paid from the old request list, then its deposit address paid from L1 as well.
    const link = request({
      id: "link",
      direction: "outgoing",
      kind: "link",
      contactTag: "",
      sipaAddress: SIPA,
      status: "paid" as never,
      fulfillmentTxHash: "0xpaid",
    })
    const rows = [tx({ action: "receive", txHash: "0xpaid", timestamp: NOW })]
    const requests = resolveRequests([link as never], { rows, deposits: [once] })
    expect([requests[0].status, requests[0].paidByDeposit]).toEqual(["fulfilled", undefined])
    expect(kinds(feedOf({ rows, requests, deposits: [once] }).items)).toEqual([
      "paidLink:link",
      `deposit:${SIPA}`,
    ])
  })

  it("lists a payment to a link an L2 receive paid as a deposit", () => {
    const link = request({
      id: "link",
      direction: "outgoing",
      kind: "link",
      contactTag: "",
      sipaAddress: SIPA,
      status: "fulfilled",
      fulfillmentTxHash: "0xpaid",
    })
    const rows = [tx({ action: "receive", txHash: "0xpaid", timestamp: NOW })]
    expect(kinds(feedOf({ rows, requests: [link], deposits: [once] }).items)).toEqual([
      "paidLink:link",
      `deposit:${SIPA}`,
    ])
  })
})

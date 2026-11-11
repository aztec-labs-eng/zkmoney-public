import { describe, expect, it } from "vitest"
import type { Hex } from "viem"
import type { OldVersionWithdrawal } from "../../src/core/migration/OldVersionWithdrawalStorage"
import type { BridgeInRecord } from "../../src/core/services/crossChain/types"
import type { FeedContext, FeedItem } from "../../src/engine/activityFeed"
import {
  nonContactInbox,
  selectActivity,
  selectHome,
  selectRequests,
} from "../../src/engine/activityFeed"
import { createBridgeIns } from "../../src/engine/bridgeIns"
import { openDatabase } from "../../src/engine/database"
import { memoryBackend } from "../../src/engine/memoryBackend"
import { resolveRequests } from "../../src/engine/requests"
import type { SIPADepositPhase, SipaDeposit } from "../../src/engine/sipaDeposits"
import type { OperationRecord } from "../../src/engine/operationTransition"
import {
  ada,
  addr,
  burn,
  deposit,
  E18,
  feedOf,
  HOUR,
  kinds,
  link,
  NOW,
  request,
  token,
  tx,
} from "./feedFixtures"

describe("selectFeed", () => {
  it("merges every source newest first, keeping the merge order on a tie", () => {
    const feed = feedOf({
      rows: [tx({ action: "send", txHash: "0xs", timestamp: NOW - 2 * HOUR })],
      requests: [request()],
      deposits: [deposit()],
      withdrawals: [burn()],
    })
    expect(kinds(feed.items)).toEqual([
      "request:req",
      "tx:0xs",
      "deposit:" + addr("d1"),
      "withdrawal:w1",
    ])
  })

  it("reads direction and pending from the records", () => {
    const items = feedOf({
      rows: [
        tx({ action: "send", txHash: "", id: "op1", status: "pending" }),
        tx({ action: "receive", txHash: "0xr" }),
      ],
      links: [
        link({ txHash: "0xp", untilClaimable: NOW / 1000 + 60 }),
        link({ txHash: "0xq", isClaimed: true }),
      ],
    }).items
    const by = Object.fromEntries(items.map((i) => [i.id, [i.direction, i.pending]]))
    expect(by).toEqual({
      "op1": ["out", true],
      "0xr": ["in", false],
      // An unclaimed link is funds that left and have not arrived.
      "0xp": ["out", true],
      "0xq": ["out", false],
    })
  })

  it("lists one row for a link's round trip, and the paid link for the receive that paid it", () => {
    const link = request({
      id: "link",
      direction: "outgoing",
      kind: "link",
      contactTag: "",
      status: "fulfilled",
      fulfillmentTxHash: "0xpaid",
    })
    const items = feedOf({
      rows: [
        tx({ action: "receive", txHash: "0xpaid" }),
        tx({ action: "Claim Back From Email", txHash: "0xback" }),
      ],
      requests: [link],
    }).items
    expect(kinds(items)).toEqual(["paidLink:link"])
    expect(items[0]).toMatchObject({ amount: { atomic: 5n * E18, decimals: 18 } })
  })

  it("shows a link as recovering while its refund is local, from the refund's begin", () => {
    const funded = link({ txHash: "0xf", untilClaimable: Math.floor(NOW / 1000) + 3600 })
    const refund = {
      operationId: "refund",
      flow: "paylink-reclaim",
      summary: "",
      state: "local",
      startedAt: NOW,
      kind: "paylink-refund",
      payload: { networkId: "net", token, amountAtomic: "0", flavor: "direct", linkId: "0xf" },
    } as OperationRecord
    const recovering = (state: OperationRecord["state"]) => {
      const operations = [{ ...refund, state }]
      const [item] = feedOf({ links: [funded], operations }).items
      return item.kind === "link" ? item.view.recovering : "none"
    }
    expect(recovering("local")).toBe("cancel")
    expect(recovering("failed")).toBeFalsy()
  })

  it("dates an L2-paid link at its payment, which can land long after the ask", () => {
    const link = request({
      id: "link",
      direction: "outgoing",
      kind: "link",
      contactTag: "",
      status: "fulfilled",
      createdAt: NOW - 3 * HOUR,
      fulfillmentTxHash: "0xpaid",
    })
    const rows = [tx({ action: "receive", txHash: "0xpaid", timestamp: NOW })]
    const [item] = feedOf({ rows, requests: [link] }).items
    expect(item.ts).toBe(NOW)
  })

  it("shows a link paid before payments were read as its Paid row, with no evidence left", () => {
    const paid = { ...request({ id: "link", direction: "outgoing", kind: "link", contactTag: "" }) }
    const requests = resolveRequests([{ ...paid, status: "paid" }], { rows: [], deposits: [] })
    expect(kinds(feedOf({ requests }).items)).toEqual(["paidLink:link"])
  })

  it("names the contact a send to a retired address carries by tag", () => {
    const feed = feedOf({
      rows: [tx({ action: "send", to: "0xold", toTag: "ada", txHash: "0xs" })],
    })
    expect(feed.items[0]).toMatchObject({ kind: "tx", contact: ada })
  })

  it("shows only open requests a contact made, unexpired and never listed codes", () => {
    const items = feedOf({
      requests: [
        request({ id: "open" }),
        request({ id: "stranger", contactTag: "kai" }),
        request({ id: "expired", expiresAt: NOW - 1 }),
        request({
          id: "code",
          direction: "outgoing",
          kind: "link",
          contactTag: "",
          unlisted: true,
        }),
        request({ id: "paid", status: "fulfilled" }),
      ],
    }).items
    expect(kinds(items)).toEqual(["request:open"])
    expect(items[0]).toMatchObject({ role: "incoming", direction: "out", contact: ada })
  })

  it("hides incoming requests until the contacts are read", () => {
    const feed = feedOf(
      { requests: [request(), request({ id: "mine", direction: "outgoing" })] },
      { contacts: { rows: [], hydrated: false, failed: true } },
    )
    expect(kinds(feed.items)).toEqual(["request:mine"])
    expect(feed.requestsUnavailable).toBe(true)
  })

  it("says a link's payment is detected before its claim pays it", () => {
    const link = request({
      direction: "outgoing",
      kind: "link",
      contactTag: "",
      sipaAddress: addr("d1"),
    })
    const [item] = feedOf({ requests: [link], deposits: [deposit({ phase: "sweeping" })] }).items
    expect(item).toMatchObject({ kind: "request", role: "outgoingLink", detected: true })
  })

  it("hides the deposit behind a request link, an upgrade, its own burn, or no funds at all", () => {
    const linked = deposit({ sipaAddress: addr("01") })
    const upgrade = deposit({ sipaAddress: addr("02") })
    const own = deposit({ sipaAddress: addr("03"), phase: "pendingClaim" })
    const empty = deposit({
      sipaAddress: addr("04"),
      phase: "broadcast",
      amount: "0",
      netAmount: undefined,
    })
    const feed = feedOf({
      requests: [request({ direction: "outgoing", kind: "link", sipaAddress: addr("01") })],
      deposits: [linked, upgrade, own, empty],
      withdrawals: [burn({ recipient: addr("03"), intent: "registration", phase: "l2_mined" })],
      upgrades: [
        {
          run: "r",
          id: "first",
          first: true,
          recipient: addr("02"),
          amount: "1",
          exitFee: "0",
          state: "planned",
          approved: true,
          startTime: NOW,
        },
      ],
    })
    expect(feed.items.filter((i) => i.kind === "deposit")).toEqual([])
  })

  it("dates a migration's arrival just above its exit, pending while unfunded", () => {
    const exit = burn({
      intent: "migration",
      recipient: addr("0a"),
      phase: "done",
      endTime: NOW - HOUR,
    })
    const arrival = deposit({
      sipaAddress: addr("0a"),
      phase: "broadcast",
      amount: "0",
      netAmount: undefined,
      startTime: NOW - 9 * HOUR,
    })
    const item = feedOf({ deposits: [arrival], withdrawals: [exit] }).items.find(
      (i) => i.kind === "deposit",
    )
    expect(item).toMatchObject({ intent: "migration", ts: NOW - HOUR + 1, arriving: {} })
    const failed = feedOf({ deposits: [arrival], withdrawals: [{ ...exit, phase: "failed" }] })
    expect(failed.items.some((i) => i.kind === "deposit")).toBe(false)
  })

  it("shows a fresh-address withdrawal as one row over its legs", () => {
    const groupId = `0x${"9a".repeat(32)}` as Hex
    const feed = feedOf({
      withdrawals: [
        burn({ localId: "gas", groupId, groupLeg: "gas" }),
        burn({ localId: "funds", groupId, groupLeg: "funds", phase: "finalizing_l1" }),
      ],
    })
    expect(kinds(feed.items)).toEqual([`withdrawalGroup:${groupId}`])
    expect(feed.items[0]).toMatchObject({ pending: true, direction: "out", unsent: false })
  })

  it("files a registration's tag price as its own row, under the claimed deposit", () => {
    const record = deposit({ registrationFee: (3n * E18).toString() } as never)
    const feed = feedOf(
      { deposits: [record] },
      {
        registrations: {
          records: [{ sipaAddress: record.sipaAddress, tag: "ada", phase: "confirmed" } as never],
        },
      },
    )
    const [row, tag] = feed.items
    expect(row).toMatchObject({ kind: "deposit", intent: "registration", tag: "ada" })
    expect(tag).toMatchObject({ kind: "tagPurchase", ts: row.ts - 1, direction: "out" })
  })

  // Activity adds up to the balance: the registration row reads what landed plus the tag's price.
  it("gives a registration row the price its tag purchase row takes back off", () => {
    const record = deposit({ registrationFee: (3n * E18).toString() } as never)
    const registrations = {
      records: [{ sipaAddress: record.sipaAddress, tag: "ada", phase: "confirmed" } as never],
    }
    const items = (d: SipaDeposit) => feedOf({ deposits: [d] }, { registrations }).items
    const [row, tag] = items(record)
    expect(tag).toMatchObject({ kind: "tagPurchase", price: (5n * E18) / 2n })
    expect(row).toMatchObject({ kind: "deposit", tagPrice: (5n * E18) / 2n })
    // No purchase row until the deposit is claimed, so nothing to add back.
    expect(items({ ...record, phase: "pendingClaim" })[0]).not.toHaveProperty("tagPrice")
  })

  it("keeps the registration row unless a burn from this wallet paid it", () => {
    const registration = { sipaAddress: addr("0b"), ts: NOW }
    expect(kinds(feedOf({}, { registration }).items)).toEqual(["registration:registration-deposit"])
    const paid = feedOf(
      { withdrawals: [burn({ intent: "registration", recipient: addr("0b") })] },
      { registration },
    )
    expect(paid.items.some((i) => i.kind === "registration")).toBe(false)
  })

  it("lists an upgrade's direct deposits as its run once this device's runs are read", () => {
    const direct = deposit({
      sipaAddress: addr("c3"),
      direct: { portal: addr("f1") },
    } as never)
    expect(feedOf({ deposits: [direct] }).upgradeRuns).toHaveLength(1)
    expect(feedOf({ deposits: [direct], upgradesLoaded: false }).upgradeRuns).toHaveLength(0)
  })

  it("retires a link made on another rollup: nothing here shares or recovers it", () => {
    const made = link({
      txHash: "0xp",
      paylink: "https://l/#x",
      untilClaimable: NOW / 1000 + 60,
      networkId: "0xold",
    })
    const view = (activeNetworkId: string) =>
      (
        feedOf({ links: [made] }, { activeNetworkId }).items[0] as Extract<
          FeedItem,
          { kind: "link" }
        >
      ).view
    expect(view("0xold")?.canShare).toBe(true)
    expect(view("0xnew")?.canShare).toBe(false)
  })

  it("offers a link's recovery only to the account that made it", () => {
    const nowSec = NOW / 1000
    const made = link({
      txHash: "0xp",
      paylink: "https://l/#x",
      fallbackSecret: "0xf",
      obsidionAccountAddress: "0xone",
      fromClaimable: 0,
      untilClaimable: nowSec + 86_400,
      refundableUntil: nowSec + 3_600,
    })
    const offer = (account: string) =>
      (
        feedOf({ links: [made] }, { chainNowSec: nowSec, account }).items[0] as Extract<
          FeedItem,
          { kind: "link" }
        >
      ).creatorAction
    expect(offer("0xONE")).toBe("cancel")
    // A backup passkey add moves the wallet onto a new account; the escrow refunds only its maker.
    expect(offer("0xtwo")).toBeUndefined()
  })

  it("lists an old-version withdrawal, pending while it sends", () => {
    const run = (phase: OldVersionWithdrawal["phase"]) =>
      ({
        id: "ov",
        startTime: NOW,
        to: addr("e9"),
        refunds: [],
        phase,
      } as unknown as OldVersionWithdrawal)
    const [sending] = feedOf({ oldVersionWithdrawals: [run("sending")] }).items
    expect(sending).toMatchObject({
      kind: "oldVersionWithdrawal",
      id: "old-version-withdrawal:ov",
      direction: "out",
      pending: true,
    })
    expect(feedOf({ oldVersionWithdrawals: [run("done")] }).items[0].pending).toBe(false)
  })

  describe("bridge-ins", () => {
    const bridged = (status: BridgeInRecord["status"]): BridgeInRecord => ({
      id: `bridge-in:0x${"b1".repeat(32)}`,
      originTxHash: `0x${"b1".repeat(32)}`,
      originChainId: 8453,
      depositor: addr("a1"),
      recipient: addr("D1"),
      symbol: "USDC",
      inputAmount: "20500000",
      outputAmount: (20n * E18).toString(),
      fee: "500000",
      inputDecimals: 6,
      outputSymbol: "DAI",
      outputDecimals: 18,
      status,
      startTime: NOW - HOUR,
    })
    const unfunded = deposit({ phase: "broadcast", amount: "0", netAmount: undefined })

    it("lists a bridge-in while it bridges, and once it comes back", () => {
      const [pending] = feedOf({ bridgeIns: [bridged("pending")] }).items
      expect(pending).toMatchObject({
        kind: "bridgeIn",
        id: `bridge-in:0x${"b1".repeat(32)}`,
        direction: "in",
        pending: true,
      })
      for (const status of ["refunded", "expired"] as const)
        expect(feedOf({ bridgeIns: [bridged(status)] }).items).toMatchObject([
          { kind: "bridgeIn", pending: false },
        ])
    })

    it("hands a bridge-in to its deposit's row only once the deposit is funded", () => {
      for (const status of ["pending", "filled"] as const) {
        const record = bridged(status)
        const row = `bridgeIn:bridge-in:0x${"b1".repeat(32)}`
        // No deposit record yet, or one that has not seen the funds: the bridge-in stands for it.
        expect(kinds(feedOf({ bridgeIns: [record] }).items)).toEqual([row])
        expect(kinds(feedOf({ bridgeIns: [record], deposits: [unfunded] }).items)).toEqual([row])
        expect(kinds(feedOf({ bridgeIns: [record], deposits: [deposit()] }).items)).toEqual([
          `deposit:${addr("d1")}`,
        ])
      }
    })

    it("names the bridge-in on the funded deposit it paid, once, on one row", () => {
      // Funds can reach the address before the provider reports the fill.
      for (const status of ["pending", "filled"] as const) {
        // The recipient is matched without case.
        const record = { ...bridged(status), recipient: addr("d1").toUpperCase() as Hex }
        const { items } = feedOf({ bridgeIns: [record], deposits: [deposit()] })
        expect(items).toHaveLength(1)
        expect(items[0]).toMatchObject({ kind: "deposit", bridgeIn: record })
      }
    })

    it("names no bridge-in on a deposit another address or a returned bridge-in paid", () => {
      const other = { ...bridged("filled"), recipient: addr("e9") }
      const withOther = feedOf({ bridgeIns: [other], deposits: [deposit()] }).items
      expect(withOther.find((i) => i.kind === "deposit")).not.toHaveProperty("bridgeIn")
      for (const status of ["refunded", "expired"] as const) {
        const items = feedOf({ bridgeIns: [bridged(status)], deposits: [deposit()] }).items
        expect(items.find((i) => i.kind === "deposit")).not.toHaveProperty("bridgeIn")
        expect(kinds(items)).toContain(`bridgeIn:bridge-in:0x${"b1".repeat(32)}`)
      }
    })

    it("lists a sped-up bridge-in once, under its own id", async () => {
      const store = createBridgeIns({ db: openDatabase(memoryBackend()), newId: () => "a" })
      const { originTxHash, ...sent } = bridged("pending")
      const { id } = await store.start({
        ...sent,
        quote: {
          inputAmount: 20_500_000n,
          maxInputAmount: 20_500_000n,
          outputAmount: 20n * E18,
          fee: 500_000n,
          fillSeconds: 4,
          txs: [{ chainId: 8453, to: addr("b5") as Hex, data: "0xb0b0" }],
        },
        nonceHint: 0,
      })
      expect(feedOf({ bridgeIns: [...store.list.get().records] }).items).toEqual([])
      await store.markSent(id, originTxHash!)
      await store.apply(id, [{ type: "sent", originTxHash: `0x${"5e".repeat(32)}` }])
      expect(kinds(feedOf({ bridgeIns: [...store.list.get().records] }).items)).toEqual([
        "bridgeIn:bridge-in:a",
      ])
    })

    it("lists a bridge-in paying someone else as an outgoing payment, never on a deposit", () => {
      const pays = { payee: "bob", requestId: "r1" }
      for (const status of ["pending", "filled"] as const) {
        const record = { ...bridged(status), pays }
        const { items } = feedOf({ bridgeIns: [record], deposits: [deposit()] })
        expect(items.find((i) => i.kind === "deposit")).not.toHaveProperty("bridgeIn")
        expect(items.find((i) => i.kind === "bridgeIn")).toMatchObject({
          direction: "out",
          pending: status === "pending",
          pays,
        })
      }
    })

    it("leaves out a bridge-in whose call was never sent", () => {
      const { originTxHash: _, ...unsent } = bridged("signing")
      expect(feedOf({ bridgeIns: [unsent, { ...unsent, status: "failed" }] }).items).toEqual([])
    })

    it("is not hydrated until the bridge-ins load", () => {
      expect(feedOf({}).hydrated).toBe(true)
      expect(feedOf({ bridgeInsHydrated: false }).hydrated).toBe(false)
    })
  })

  describe("a deposit replayed onto this device", () => {
    const FUNDING = `0x${"f1".repeat(32)}` as Hex
    const replayed = (over: Partial<SipaDeposit> = {}) =>
      deposit({ replayed: true, fundingTxHash: FUNDING, ...over })
    const rebuilt: BridgeInRecord = {
      id: "bridge-in:rebuilt",
      originTxHash: `0x${"b1".repeat(32)}`,
      originChainId: 56,
      depositor: addr("a1"),
      recipient: addr("d1"),
      symbol: "USDT",
      inputAmount: "20000000",
      outputAmount: (20n * E18).toString(),
      fee: "0",
      inputDecimals: 18,
      outputSymbol: "DAI",
      outputDecimals: 18,
      status: "filled",
      startTime: NOW - 4 * HOUR,
      replayed: true,
    }
    const row = [`deposit:${addr("d1")}`]

    it("lists at once, whatever its funding is known to be", () => {
      for (const over of [
        { fundingTxHash: undefined },
        {},
        { funding: "transfer" as const },
        { funding: "bridge" as const },
      ])
        expect(kinds(feedOf({ deposits: [replayed(over)] }).items)).toEqual(row)
    })

    it("gains its bridge-in once one is rebuilt", () => {
      const bridged = replayed({ funding: "bridge" })
      const { items } = feedOf({ deposits: [bridged], bridgeIns: [rebuilt] })
      expect(kinds(items)).toEqual(row)
      expect(items[0]).toMatchObject({ bridgeIn: rebuilt })
    })
  })

  it("leaves a deposit to a rotated wallet's previous account out of what Home counts as arriving", () => {
    const previous = `0x${"0d".repeat(32)}`
    const swept = deposit({ phase: "pendingClaim", recipientL2Address: previous })
    expect(feedOf({ deposits: [swept] }).arriving.main).toBe(20n * E18)
    expect(
      feedOf({ deposits: [swept] }, { previousAccount: `0x${"0D".repeat(32)}` }).arriving.main,
    ).toBe(0n)
  })

  it("lists a deposit to a rotated wallet's previous account only once it landed there", () => {
    const previous = `0x${"0D".repeat(32)}`
    const to = (phase: SIPADepositPhase, sipaAddress: string) =>
      deposit({ phase, sipaAddress, recipientL2Address: previous.toLowerCase() })
    const deposits = [
      to("pendingClaim", addr("01")),
      to("funded", addr("02")),
      to("claimed", addr("03")),
      to("recoverable", addr("04")),
      deposit({ phase: "pendingClaim", sipaAddress: addr("05") }),
    ]
    const ids = (ctx?: Partial<FeedContext>) =>
      feedOf({ deposits }, ctx)
        .items.map((i) => i.id)
        .sort()
    expect(ids({ previousAccount: previous })).toEqual([addr("03"), addr("04"), addr("05")])
    expect(ids()).toHaveLength(5)
  })

  it("lists a stuck deposit to a rotated wallet's previous account, with its exit", () => {
    const stuck = deposit({
      phase: "sweeping",
      recipientL2Address: `0x${"0d".repeat(32)}`,
      messageSecret: `0x${"01".repeat(32)}`,
      recipientHash: `0x${"02".repeat(32)}`,
      recoveryAddress: addr("b0"),
    })
    const [item] = feedOf({ deposits: [stuck] }, { previousAccount: `0x${"0D".repeat(32)}` }).items
    expect(item).toMatchObject({ id: stuck.sipaAddress, offer: { reason: "stuck" } })
  })

  it("leaves out a transfer from a rotated wallet's previous account by its sender address alone", () => {
    const previous = `0x${"0d".repeat(32)}`
    const rows = [
      tx({ action: "receive", txHash: "0xm", from: previous, senderL2Address: addr("0b") }),
      tx({ action: "receive", txHash: "0xt", from: "ada", senderL2Address: previous }),
      tx({ action: "receive", txHash: "0xo", from: "ada", senderL2Address: addr("0a") }),
      tx({ action: "send", txHash: "0xs", to: previous }),
    ]
    const ids = (ctx?: Partial<FeedContext>) =>
      feedOf({ rows }, ctx)
        .items.map((i) => i.id)
        .sort()
    expect(ids({ previousAccount: `0x${"0D".repeat(32)}` })).toEqual(["0xm", "0xo", "0xs"])
    expect(ids()).toEqual(["0xm", "0xo", "0xs", "0xt"])
  })

  it("leaves out the move a device filed as the previous account's send to this one", () => {
    const previous = `0x${"0d".repeat(32)}`
    const account = `0x${"0e".repeat(32)}`
    const send = (txHash: string, recipientL2Address: string) =>
      tx({ action: "send", txHash, senderL2Address: previous, recipientL2Address })
    const rows = [send("0xmove", account.toUpperCase()), send("0xpaid", addr("0a"))]
    const ids = (ctx?: Partial<FeedContext>) =>
      feedOf({ rows }, ctx)
        .items.map((i) => i.id)
        .sort()
    expect(ids({ previousAccount: previous, account })).toEqual(["0xpaid"])
    expect(ids({ previousAccount: previous })).toEqual(["0xmove", "0xpaid"])
    expect(ids({ account })).toEqual(["0xmove", "0xpaid"])
  })

  it("holds the skeleton while a chain scan rebuilds history", () => {
    expect(feedOf({ catchingUp: true }).hydrated).toBe(false)
    expect(feedOf().hydrated).toBe(true)
  })
})

describe("selectors over the feed", () => {
  const feed = feedOf({
    rows: [tx({ action: "send", txHash: "0xs" }), tx({ action: "receive", txHash: "0xr" })],
    requests: [request(), request({ id: "mine", direction: "outgoing" })],
  })

  it("lifts incoming requests out of Home's feed", () => {
    const home = selectHome(feed)
    expect(kinds(home.requests)).toEqual(["request:req"])
    expect(home.feed.map((i) => i.id)).toEqual(["0xs", "0xr", "mine"])
  })

  it("files unpaid requests under Pending only", () => {
    expect(selectActivity(feed.items, "Sent").map((i) => i.id)).toEqual(["0xs"])
    expect(selectActivity(feed.items, "Received").map((i) => i.id)).toEqual(["0xr"])
    expect(selectActivity(feed.items, "Pending").map((i) => i.id)).toEqual(["req", "mine"])
  })

  it("splits Requests into what the user asked and what they owe, counting the inbox", () => {
    const boxes = selectRequests(feed, 2)
    expect([kinds(boxes.sent), kinds(boxes.received), boxes.receivedCount]).toEqual([
      ["request:mine"],
      ["request:req"],
      3,
    ])
  })
})

describe("nonContactInbox", () => {
  it("lists pending, unexpired requests from non-contacts, newest first", () => {
    const requests = [
      request({ id: "old", contactTag: "mina", createdAt: NOW - 3 * HOUR }),
      request({ id: "new", contactTag: "mina", createdAt: NOW - HOUR }),
      request({ id: "contact", contactTag: "ADA" }),
      request({ id: "auto", contactTag: "bo" }),
      request({ id: "mine", contactTag: "mina", direction: "outgoing" }),
      request({ id: "paid", contactTag: "mina", status: "fulfilled" }),
      request({ id: "expired", contactTag: "mina", expiresAt: NOW - 1 }),
      request({ id: "open", contactTag: "mina", expiresAt: NOW + 1, createdAt: NOW - 4 * HOUR }),
    ]
    const contacts = [ada, { ...ada, id: "bo", tag: "bo", autoAdded: true }]
    expect(nonContactInbox(requests, contacts, NOW).map((r) => r.id)).toEqual([
      "new",
      "auto",
      "old",
      "open",
    ])
  })
})

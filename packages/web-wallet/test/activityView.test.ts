import { describe, expect, it } from "vitest"
import { PaylinkActionEnum } from "@obsidion/core/constants"
import {
  formatDateLabel,
  formatTimeLabel,
  PAYLINK_STATUS_LABEL,
  type ContactRow,
  type SIPADepositRecord,
  type Transaction,
  INTERRUPTED_ERRORS,
  INTERRUPTED_SEND_ERROR,
  withRefundInFlight,
} from "@obsidion/front-core"
import {
  buildActivityRows,
  depositAttribution,
  depositGrossFigure,
  depositHeadline,
  depositRowAmount,
  isPendingActivityRow,
  linkFragmentOf,
  txNoteFor,
  DETECTING_AMOUNT,
} from "../src/ui/screens/activityView"

const L2_ADDR = "0x" + "0a".repeat(32)
const OTHER_L2 = "0x" + "0c".repeat(32)
const ZERO_L2 = "0x" + "00".repeat(32)
const ETH_ADDR = "0x1111111111111111111111111111111111111111"

const alice: ContactRow = {
  id: "alice",
  name: "Alice",
  tag: "alice",
  address: L2_ADDR,
  addressKind: "aztec-l2",
}

const coldWallet: ContactRow = {
  id: `l1:rainbow:${ETH_ADDR}`,
  name: "My cold wallet",
  tag: "0x1111...1111",
  address: ETH_ADDR,
  addressKind: "ethereum-l1",
}

function directory(rows: ContactRow[]) {
  return {
    contacts: rows,
    lookup: (idOrTag: string) => rows.find((c) => c.id === idOrTag || c.tag === idOrTag),
    lookupByAddress: (address: string) => {
      const needle = address.toLowerCase()
      return rows.find((c) => c.addressKind !== "ethereum-l1" && c.address.toLowerCase() === needle)
    },
  }
}

const token = { name: "Dai", symbol: "DAI", amount: 25, price: 1 }

const send = (to: string, over: Partial<Transaction> = {}): Transaction =>
  ({
    action: "send",
    token,
    to,
    timestamp: 1000,
    status: "success",
    txHash: "0x" + "1".repeat(64),
    ...over,
  } as Transaction)

const receive = (from: string, over: Record<string, unknown> = {}): Transaction =>
  ({
    action: "receive",
    token,
    from,
    timestamp: 2000,
    status: "success",
    txHash: "0x" + "2".repeat(64),
    ...over,
  } as Transaction)

describe("buildActivityRows — counterparty enrichment", () => {
  it("shows the saved contact name and attaches the contact for a send to a saved address", () => {
    const [row] = buildActivityRows([send(L2_ADDR)], directory([alice]))
    expect(row.counterparty).toBe("Alice")
    expect(row.contact).toBe(alice)
    expect(row.amount).toBe("-$25.00")
  })

  it("resolves a bare-tag receive and a decorated-tag receive to the same contact", () => {
    const dir = directory([alice])
    const [bare] = buildActivityRows([receive("alice")], dir)
    const [decorated] = buildActivityRows([receive("@alice.zk.money")], dir)
    expect(bare.contact).toBe(alice)
    expect(decorated.contact).toBe(alice)
    expect(bare.counterparty).toBe("Alice")
    expect(decorated.counterparty).toBe("Alice")
  })

  it("resolves a receive by senderL2Address when `from` carries an unsaved label", () => {
    const [row] = buildActivityRows(
      [receive("someone", { senderL2Address: L2_ADDR })],
      directory([alice]),
    )
    expect(row.contact).toBe(alice)
    expect(row.counterparty).toBe("Alice")
  })

  it("names an unrenamed contact by its @tag, as request rows do", () => {
    const bob: ContactRow = { id: "bob", name: "bob", tag: "bob", address: OTHER_L2, addressKind: "aztec-l2" }
    const [row] = buildActivityRows([send(OTHER_L2)], directory([bob]))
    expect(row.counterparty).toBe("@bob")
  })

  it("an L1 contact never matches an L2 counterparty (address shapes differ)", () => {
    const [row] = buildActivityRows([send(OTHER_L2)], directory([coldWallet]))
    expect(row.contact).toBeUndefined()
  })
})

describe("buildActivityRows — unsaved fallbacks", () => {
  it("names an unsaved send by the tag it was sent to", () => {
    const [row] = buildActivityRows([send(OTHER_L2, { toTag: "pleaswork" })], directory([]))
    expect(row.counterparty).toBe("@pleaswork")
  })


  it("truncates an unsaved send address and passes an unsaved tag through raw", () => {
    const dir = directory([])
    const [addrRow] = buildActivityRows([send(OTHER_L2)], dir)
    expect(addrRow.counterparty).toBe("0x0c0c...0c0c0c")
    const [tagRow] = buildActivityRows([receive("bob")], dir)
    expect(tagRow.counterparty).toBe("bob")
  })

  it("labels a zero-address receive Faucet and an unknown-address receive Unknown sender", () => {
    const dir = directory([])
    const [faucet] = buildActivityRows([receive(ZERO_L2)], dir)
    expect(faucet.counterparty).toBe("Faucet")
    const [unknown] = buildActivityRows([receive(OTHER_L2)], dir)
    expect(unknown.counterparty).toBe("Unknown sender")
  })
})

describe("txNoteFor", () => {
  const hash = "0x" + "2".repeat(64)
  const request = (over: Record<string, unknown>) =>
    ({ id: "req", contactTag: "alice", amount: 25, note: "Pizza dinner", ...over } as never)

  it("prefers the transfer's own memo", () => {
    const [row] = buildActivityRows([receive("alice", { memo: "thanks!" })], directory([alice]))
    expect(row.note).toBe("thanks!")
    expect(txNoteFor(row, [request({ fulfillmentTxHash: hash })])).toBe("thanks!")
  })

  it("falls back to the note of the request the transfer fulfilled", () => {
    const [row] = buildActivityRows([receive("alice")], directory([alice]))
    expect(row.note).toBeUndefined()
    expect(txNoteFor(row, [request({ fulfillmentTxHash: hash.toUpperCase() })])).toBe(
      "Pizza dinner",
    )
    expect(txNoteFor(row, [request({ fulfillmentTxHash: "0x" + "9".repeat(64) })])).toBeUndefined()
    expect(txNoteFor({ ...row, txHash: undefined }, [request({ fulfillmentTxHash: hash })])).toBe(
      undefined,
    )
  })
})

describe("buildActivityRows — row projection", () => {
  it("labels paylink and faucet rows and signs their amounts", () => {
    const rows = buildActivityRows(
      [
        send(L2_ADDR, {
          action: PaylinkActionEnum.PAY,
          emailPaymentAction: PaylinkActionEnum.PAY,
        } as never),
        receive("x", { action: "faucet", from: undefined }),
      ],
      directory([]),
    )
    const paylink = rows.find((r) => r.counterparty === "Sent via paylink")
    expect(paylink?.amount).toBe("-$25.00")
    expect(paylink?.avatarIcon).toBe("link")
    const faucet = rows.find((r) => r.counterparty === "Faucet drip")
    expect(faucet?.amount).toBe("+$25.00")
  })

  it("folds a refund into the create row instead of listing it twice", () => {
    // The escrow left and came back: one movement of money, so one row — the create row, which
    // reads "Refunded" and carries the refund's own hash.
    const rows = buildActivityRows(
      [
        send(L2_ADDR, {
          action: PaylinkActionEnum.CLAIM_BACK,
          emailPaymentAction: PaylinkActionEnum.CLAIM_BACK,
        } as never),
      ],
      directory([alice]),
    )
    expect(rows).toHaveLength(0)
  })

  it("filters non-activity rows and sorts newest first", () => {
    const creation = { action: "create_account", timestamp: 3000, status: "success", txHash: "" }
    const rows = buildActivityRows(
      [send(L2_ADDR), receive("bob"), creation as unknown as Transaction],
      directory([]),
    )
    expect(rows).toHaveLength(2)
    expect(rows[0].id).toBe("0x" + "2".repeat(64))
  })

  it("marks pending and failed rows", () => {
    const [pending] = buildActivityRows([send(L2_ADDR, { status: "pending" })], directory([]))
    // The pill says Pending; the time slot keeps the time.
    expect(pending.statusLabel).toBe("Pending")
    const when = (ms: number) => `${formatDateLabel(ms)}, ${formatTimeLabel(ms)}`
    expect(pending.timestamp).toBe(when(pending.timestampMs))
    expect(pending.avatarIcon).toBe("clock-outline")
    const [receiving] = buildActivityRows([receive("bob", { status: "pending" })], directory([]))
    expect(receiving.statusLabel).toBe("Pending")
    expect(receiving.timestamp).toBe(when(receiving.timestampMs))
    expect(receiving.avatarIcon).toBe("clock-outline")
    const [failed] = buildActivityRows([send(L2_ADDR, { status: "failed" })], directory([]))
    expect(failed.statusLabel).toBe("Failed")
  })

  it("carries a failed row's reason in words, never its raw throw", () => {
    const [interrupted] = buildActivityRows(
      [send(L2_ADDR, { status: "failed", error: INTERRUPTED_ERRORS.send })],
      directory([]),
    )
    expect(interrupted.error).toBe(INTERRUPTED_ERRORS.send)
    // A row an older sweep failed keeps its reason, in the current words.
    const [legacy] = buildActivityRows(
      [send(L2_ADDR, { status: "failed", error: INTERRUPTED_SEND_ERROR })],
      directory([]),
    )
    expect(legacy.error).toBe(INTERRUPTED_ERRORS.send)
    const legacyLinks = buildActivityRows(
      [PaylinkActionEnum.PAY, PaylinkActionEnum.CLAIM].map((action) =>
        send(L2_ADDR, {
          action,
          emailPaymentAction: action,
          timestamp: action === PaylinkActionEnum.PAY ? 2 : 1,
          status: "failed",
          error: INTERRUPTED_SEND_ERROR,
        } as never),
      ),
      directory([]),
    )
    expect(legacyLinks.map((row) => row.error)).toEqual([
      INTERRUPTED_ERRORS.paylinkCreate,
      INTERRUPTED_ERRORS.paylinkClaim,
    ])
    // A raw throw reads as a plain line; any error on a row that did not fail stays off the screen.
    const [raw] = buildActivityRows(
      [send(L2_ADDR, { status: "failed", error: "Assertion failed: Balance too low" })],
      directory([]),
    )
    expect(raw.error).toBe("It didn't go through. The amount is still in your balance.")
    const [succeeded] = buildActivityRows(
      [send(L2_ADDR, { status: "success", error: INTERRUPTED_SEND_ERROR })],
      directory([]),
    )
    expect(succeeded.error).toBeUndefined()
  })

  it("exposes the claim URL and row-derived status on creator paylink rows only", () => {
    const nowSec = 1_800_000_000
    const rows = buildActivityRows(
      [
        send(L2_ADDR, {
          action: PaylinkActionEnum.PAY,
          emailPaymentAction: PaylinkActionEnum.PAY,
          paylink: "https://wallet.example/link#frag",
          untilClaimable: nowSec + 60,
        } as never),
        send(L2_ADDR, {
          action: PaylinkActionEnum.CLAIM,
          emailPaymentAction: PaylinkActionEnum.CLAIM,
          txHash: "0x" + "3".repeat(64),
        } as never),
      ],
      directory([]),
      nowSec,
    )
    const pay = rows.find((r) => r.counterparty === "Sent via paylink")!
    const claim = rows.find((r) => r.counterparty === "Received via paylink")!
    expect(pay.paylink).toBe("https://wallet.example/link#frag")
    expect(pay.paylinkStatus).toBe("awaitingClaim")
    expect(pay.txHash).toBe("0x" + "1".repeat(64))
    expect(claim.paylink).toBeUndefined()
    expect(claim.paylinkStatus).toBeUndefined()
  })

  it("derives expired/claimed paylink status from row fields", () => {
    const nowSec = 1_800_000_000
    const pay = (over: object) =>
      send(L2_ADDR, {
        action: PaylinkActionEnum.PAY,
        emailPaymentAction: PaylinkActionEnum.PAY,
        paylink: "https://x/link#f",
        ...over,
      } as never)
    const [expired] = buildActivityRows(
      [pay({ untilClaimable: nowSec - 1 })],
      directory([]),
      nowSec,
    )
    expect(expired.paylinkStatus).toBe("expired")
    const [claimed] = buildActivityRows([pay({ isClaimed: true })], directory([]), nowSec)
    expect(claimed.paylinkStatus).toBe("claimed")
  })
})

const NOW_SEC = 1_800_000_000

const payRow = (over: object): Transaction =>
  send(L2_ADDR, {
    action: PaylinkActionEnum.PAY,
    emailPaymentAction: PaylinkActionEnum.PAY,
    paylink: "https://x/link#f",
    ...over,
  } as never)

const builtPayRow = (over: object) => buildActivityRows([payRow(over)], directory([]), NOW_SEC)[0]

/** A creator row with its refund material intact — what `paylinkRefundEligibility` reads. */
const escrowRow = (flavor: "email" | "direct", untilClaimable: number): Transaction =>
  payRow({ flavor, fallbackSecret: `0x${"55".repeat(32)}`, fromClaimable: 0, untilClaimable })

describe("buildActivityRows — the recovery a creator link row offers", () => {
  it("offers the reclaim on a link past its window", () => {
    expect(
      buildActivityRows([escrowRow("email", NOW_SEC - 1)], directory([]), NOW_SEC)[0].creatorAction,
    ).toBe("reclaim")
    expect(
      buildActivityRows([escrowRow("direct", NOW_SEC - 1)], directory([]), NOW_SEC)[0]
        .creatorAction,
    ).toBe("reclaim")
  })

  it("offers cancel while the refund window is still open", () => {
    const row = payRow({
      flavor: "direct",
      fallbackSecret: `0x${"55".repeat(32)}`,
      fromClaimable: 0,
      untilClaimable: NOW_SEC + 86_400,
      refundableUntil: NOW_SEC + 60,
    })
    expect(buildActivityRows([row], directory([]), NOW_SEC)[0].creatorAction).toBe("cancel")
  })

  it("offers nothing while only the claim window is open", () => {
    expect(
      buildActivityRows([escrowRow("direct", NOW_SEC + 60)], directory([]), NOW_SEC)[0]
        .creatorAction,
    ).toBeUndefined()
    expect(
      buildActivityRows([escrowRow("email", NOW_SEC + 60)], directory([]), NOW_SEC)[0]
        .creatorAction,
    ).toBeUndefined()
  })

  it("offers nothing where the escrow is gone or unreachable", () => {
    expect(builtPayRow({ isRefunded: true }).creatorAction).toBeUndefined()
    expect(builtPayRow({ isClaimed: true }).creatorAction).toBeUndefined()
  })

  it("offers nothing on a row that is not the creator's own link", () => {
    const [claim] = buildActivityRows(
      [
        send(L2_ADDR, {
          action: PaylinkActionEnum.CLAIM,
          emailPaymentAction: PaylinkActionEnum.CLAIM,
        } as never),
      ],
      directory([]),
      NOW_SEC,
    )
    expect(claim.creatorAction).toBeUndefined()
  })
})

describe("buildActivityRows — the badge on a creator link row", () => {
  // Same words the detail modal prints, so the row a tap opened never renames its own state.
  it.each([
    ["awaitingClaim", { untilClaimable: NOW_SEC + 60 }],
    ["claimed", { isClaimed: true }],
    ["refunded", { isRefunded: true }],
    ["migrated", { isMigrated: true }],
    ["expired", { untilClaimable: NOW_SEC - 1 }],
  ] as const)("a settled row reads out its link status: %s", (status, over) => {
    const row = builtPayRow(over)
    expect(row.paylinkStatus).toBe(status)
    expect(row.statusLabel).toBe(PAYLINK_STATUS_LABEL[status])
  })

  it("an in-flight or failed row speaks for the transaction instead", () => {
    // Past its window and flagged claimed — and none of that is settled while the create tx isn't.
    const unsettled = { untilClaimable: NOW_SEC - 1, isClaimed: true }
    expect(builtPayRow({ ...unsettled, status: "pending" }).statusLabel).toBe("Pending")
    expect(builtPayRow({ ...unsettled, status: "failed" }).statusLabel).toBe("Failed")
  })

  it("leaves every other settled row unbadged", () => {
    expect(
      buildActivityRows([send(L2_ADDR)], directory([]), NOW_SEC)[0].statusLabel,
    ).toBeUndefined()
  })

  // The badge is the whole change: the sum a link sent is still the sum it sent, refund or not.
  it("says nothing about the amount", () => {
    expect(builtPayRow({ isRefunded: true }).amount).toBe("-$25.00")
    expect(builtPayRow({ untilClaimable: NOW_SEC - 1 }).amount).toBe("-$25.00")
  })
})

describe("isPendingActivityRow — what Home and Activity file under Pending", () => {
  it("a settled link nobody has claimed, with or without a saved expiry", () => {
    expect(isPendingActivityRow(builtPayRow({ untilClaimable: NOW_SEC + 60 }))).toBe(true)
    expect(isPendingActivityRow(builtPayRow({}))).toBe(true)
  })

  it("a transaction still waiting for the network", () => {
    expect(isPendingActivityRow(builtPayRow({ status: "pending" }))).toBe(true)
    const [transfer] = buildActivityRows([send(L2_ADDR, { status: "pending" })], directory([]))
    expect(isPendingActivityRow(transfer)).toBe(true)
  })

  // A failed create keeps an unclaimed link's flags, so its link status alone would file it under
  // Pending until its expiry — forever where the failure came before one was saved.
  it("never a failed create, whether its expiry lies ahead or was never saved", () => {
    for (const over of [{ untilClaimable: NOW_SEC + 60 }, {}]) {
      const failed = builtPayRow({ ...over, status: "failed" })
      expect(failed.paylinkStatus).toBe("awaitingClaim")
      expect(failed.statusLabel).toBe("Failed")
      expect(isPendingActivityRow(failed)).toBe(false)
    }
  })

  it.each([
    ["claimed", { isClaimed: true }],
    ["refunded", { isRefunded: true }],
    ["migrated", { isMigrated: true }],
    ["expired", { untilClaimable: NOW_SEC - 1 }],
  ] as const)("not a settled link that is %s", (_status, over) => {
    expect(isPendingActivityRow(builtPayRow(over))).toBe(false)
  })

  it("not a settled transfer", () => {
    expect(isPendingActivityRow(buildActivityRows([send(L2_ADDR)], directory([]))[0])).toBe(false)
  })
})

describe("depositRowAmount", () => {
  const ONE = "1000000000000000000"
  const eth = {
    tokenAddress: "0x0000000000000000000000000000000000000000",
    tokenSymbol: "ETH",
  } as const
  function deposit(over: Partial<SIPADepositRecord>): SIPADepositRecord {
    return {
      sipaAddress: ETH_ADDR,
      recipientL2Address: L2_ADDR,
      messageSecret: "0x01",
      recipientHash: "0x02",
      recoveryAddress: ETH_ADDR,
      l1ChainId: 11155111,
      amount: "0",
      tokenSymbol: "DAI",
      phase: "broadcast",
      startTime: 1,
      ...over,
    }
  }

  // Neither phase can ever reach the L2 balance, so neither carries the "+" that colours a credit.
  it.each(["recoverable", "recovered"] as const)("shows the unsigned gross for %s", (phase) => {
    // Over the fee: a net exists, and showing it would read as money arriving.
    expect(
      depositRowAmount(deposit({ phase, amount: "4200", fee: ONE, fpcFundingCut: "0" }), true),
    ).toBe("$4200")
    // Under the fee: gross is all there ever was.
    expect(
      depositRowAmount(deposit({ phase, amount: "0.4", fee: ONE, fpcFundingCut: "0" }), true),
    ).toBe("$0.40")
    // No exit to offer (no note secret) still shows the sum sitting at the address.
    expect(
      depositRowAmount(deposit({ phase, amount: "0.2", fee: ONE, fpcFundingCut: "0" }), false),
    ).toBe("$0.20")
  })

  it("shows ETH sent to a deposit address in ETH, not dollars", () => {
    expect(depositRowAmount(deposit({ ...eth, phase: "recoverable", amount: "0.05" }), true)).toBe(
      "0.05 ETH",
    )
  })

  // A full-precision figure takes the row's width from its label on a phone.
  it.each(["recoverable", "recovered"] as const)(
    "bounds a %s ETH row's figure and keeps every digit for the detail sheet",
    (phase) => {
      const cases = [
        ["0.05", "0.05 ETH", "0.05 ETH"],
        ["0.123456789123456789", "0.12346 ETH", "0.123456789123456789 ETH"],
        ["0.000000000000000001", "<0.00001 ETH", "0.000000000000000001 ETH"],
      ]
      for (const [amount, row, detail] of cases) {
        const record = deposit({ ...eth, phase, amount })
        expect(depositRowAmount(record, phase === "recoverable")).toBe(row)
        expect(depositGrossFigure(record)).toBe(detail)
      }
    },
  )

  it("keeps a stablecoin's gross in dollars in the row and the detail sheet", () => {
    const record = deposit({ phase: "recoverable", amount: "0.123456789123456789" })
    expect(depositRowAmount(record, true)).toBe("$0.12")
    expect(depositGrossFigure(record)).toBe("$0.12")
  })

  it("credits the net once a deposit is on its way into the balance", () => {
    const record = deposit({
      phase: "claimed",
      netAmount: "249000000000000000000",
      fee: ONE,
      fpcFundingCut: "0",
    })
    expect(depositRowAmount(record, false)).toBe("+$249")
  })

  it("credits a record that carries its own net without a fee", () => {
    const record = deposit({ phase: "claimed", amount: "249", netAmount: "249000000000000000000" })
    expect(depositRowAmount(record, false)).toBe("+$249")
  })

  it.each(["sweeping", "pendingClaim"] as const)(
    "shows an unpriced %s deposit as its deposited gross, not as a credit",
    (phase) => {
      // A pass that could not read the fee writes the gross alone; crediting it would hand the user
      // the fee back on the row.
      expect(depositRowAmount(deposit({ phase, amount: "100.35" }), false)).toBe("$100.35")
    },
  )

  it("shows a priced deposit whose net is zero as its gross, not as detecting", () => {
    // 0.2 sent against a 0.35 fee: the amount is read, the credit is nothing.
    const record = deposit({
      phase: "sweeping",
      amount: "0.2",
      fee: "350000000000000000",
      fpcFundingCut: "0",
    })
    expect(depositRowAmount(record, false)).toBe("$0.20")
  })

  it("reads a zero gross on a crediting phase as detecting", () => {
    expect(depositRowAmount(deposit({ phase: "broadcast", amount: "0" }), false)).toBe(
      DETECTING_AMOUNT,
    )
  })

  it("reads a netless deposit as detecting, and as the gross where an exit is offered", () => {
    expect(depositRowAmount(deposit({ phase: "pendingClaim", amount: "0" }), false)).toBe(
      DETECTING_AMOUNT,
    )
    expect(
      depositRowAmount(
        deposit({ phase: "sweeping", amount: "0.4", fee: ONE, fpcFundingCut: "0" }),
        true,
      ),
    ).toBe("$0.40")
  })
})

describe("paylink detail helpers", () => {
  it("linkFragmentOf extracts the reconstruction fragment", () => {
    expect(linkFragmentOf("https://x/link#abc")).toBe("abc")
    expect(linkFragmentOf("https://x/link")).toBeNull()
    expect(linkFragmentOf("https://x/link#")).toBeNull()
  })
})

describe("depositAttribution", () => {
  const base = {
    sipaAddress: "0xdead",
    recipientL2Address: "0xaa",
    messageSecret: "0x1",
    recipientHash: "0x2",
    recoveryAddress: "0x3",
    l1ChainId: 11155111,
    amount: "25",
    tokenSymbol: "DAI",
    phase: "claimed" as const,
    startTime: 1,
  }

  it("prefers the on-chain Transfer sender over the session wallet", () => {
    expect(
      depositAttribution({
        ...base,
        fundingFromAddress: "0x1111111111111111111111111111111111111111",
        fundingTxHash: `0x${"ab".repeat(32)}`,
        walletAddress: "0x2222222222222222222222222222222222222222",
      } as never),
    ).toEqual({
      funder: "0x1111111111111111111111111111111111111111",
      fundingTxHash: `0x${"ab".repeat(32)}`,
    })
  })

  it("falls back to the session wallet when the Transfer has not been read yet", () => {
    expect(depositAttribution({ ...base, walletAddress: "0x22" } as never)).toEqual({
      funder: "0x22",
      fundingTxHash: undefined,
    })
  })
})

describe("depositHeadline", () => {
  it("puts the source wallet over the funder address", () => {
    expect(
      depositHeadline({
        ...{
          sipaAddress: "0xdead",
          recipientL2Address: "0xaa",
          messageSecret: "0x1",
          recipientHash: "0x2",
          recoveryAddress: "0x3",
          l1ChainId: 11155111,
          amount: "25",
          tokenSymbol: "DAI",
          phase: "claimed" as const,
          startTime: 1,
        },
        walletName: "Rainbow",
        fundingFromAddress: "0x1111111111111111111111111111111111111111",
      } as never),
    ).toEqual({
      title: "Rainbow",
      address: "0x1111111111111111111111111111111111111111",
    })
  })

  it("falls back to Wallet when the source is unnamed", () => {
    expect(depositHeadline({ walletName: "  ", walletAddress: "0x22" } as never)).toEqual({
      title: "Wallet",
      address: "0x22",
    })
  })
})

describe("buildActivityRows — what a creator link row offers across its lifecycle", () => {
  const REFUND_HASH = "0x" + "9".repeat(64)
  const cancellable = {
    flavor: "direct",
    fallbackSecret: `0x${"55".repeat(32)}`,
    fromClaimable: 0,
    untilClaimable: NOW_SEC + 86_400,
    refundableUntil: NOW_SEC + 3_600,
  }
  const refund = (status: Transaction["status"]): Transaction =>
    ({
      action: PaylinkActionEnum.CLAIM_BACK,
      emailPaymentAction: PaylinkActionEnum.CLAIM_BACK,
      token,
      timestamp: 3000,
      status,
      txHash: REFUND_HASH,
    }) as Transaction
  const withRefund = (status: Transaction["status"]) =>
    buildActivityRows(
      [payRow({ ...cancellable, refundTxHash: REFUND_HASH }), refund(status)],
      directory([]),
      NOW_SEC,
    )

  it("a pending create is shareable but offers no recovery", () => {
    const row = builtPayRow({ ...cancellable, status: "pending" })
    expect(row).toMatchObject({ counterparty: "Paylink", statusLabel: "Pending", canShare: true })
    expect(row.creatorAction).toBeUndefined()
  })

  it("a failed create offers neither Share nor recovery", () => {
    const row = builtPayRow({ ...cancellable, status: "failed" })
    expect(row).toMatchObject({ counterparty: "Paylink", statusLabel: "Failed", canShare: false })
    expect(row.creatorAction).toBeUndefined()
  })

  it("a settled unclaimed link offers Share and Cancel", () => {
    expect(builtPayRow(cancellable)).toMatchObject({
      counterparty: "Sent via paylink",
      statusLabel: "Unclaimed",
      canShare: true,
      creatorAction: "cancel",
    })
  })

  it("a refund in flight reads Cancelling and offers nothing", () => {
    const rows = withRefund("pending")
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      statusLabel: "Cancelling",
      canShare: false,
      refundStatus: "pending",
    })
    expect(rows[0].creatorAction).toBeUndefined()
  })

  // The recovery sheet hands off at the passkey; the refund proves before its hash exists.
  it("a refund this page is proving reads Cancelling before its hash reaches the row", async () => {
    const secret = `0x${"66".repeat(32)}`
    const row = payRow({ ...cancellable, payToEmailSecret: secret })
    let during: ReturnType<typeof buildActivityRows>[number] | undefined
    await withRefundInFlight(secret, async () => {
      during = buildActivityRows([row], directory([]), NOW_SEC)[0]
    })
    expect(during).toMatchObject({ statusLabel: "Cancelling", canShare: false })
    expect(during?.creatorAction).toBeUndefined()
    expect(buildActivityRows([row], directory([]), NOW_SEC)[0]).toMatchObject({
      statusLabel: "Unclaimed",
      creatorAction: "cancel",
    })
  })

  it("a landed refund reads Refunded before the reconciler flags the row", () => {
    const [row] = withRefund("success")
    expect(row).toMatchObject({ statusLabel: "Refunded", canShare: false })
    expect(row.creatorAction).toBeUndefined()
  })

  it("a failed refund returns the link to Unclaimed with Cancel", () => {
    expect(withRefund("failed")[0]).toMatchObject({
      statusLabel: "Unclaimed",
      canShare: true,
      creatorAction: "cancel",
    })
  })

  it("a pending claim row is a paylink until it settles", () => {
    const [claim] = buildActivityRows(
      [
        send(L2_ADDR, {
          action: PaylinkActionEnum.CLAIM,
          emailPaymentAction: PaylinkActionEnum.CLAIM,
          status: "pending",
        } as never),
      ],
      directory([]),
      NOW_SEC,
    )
    expect(claim).toMatchObject({ counterparty: "Paylink", statusLabel: "Pending" })
  })
})

import { describe, expect, it } from "vitest"
import type { ContactRow } from "../../src/hooks/useContactsDirectory"
import type { PaymentRequest } from "../../src/core/storages/RequestStorage"
import type { Transaction } from "../../src/types/transactions"
import {
  approvedContactTags,
  buildPaidLinkRows,
  buildRequestRows,
  isFromNonContact,
  nonContactInbox,
  payerForPaidLink,
  withoutAnsweredRequests,
  withoutPaidLinkReceives,
  type PaidLinkSipaDeposit,
} from "../../src/utils/requestRows"

const NOW = 1_800_000_000_000

function req(overrides: Partial<PaymentRequest>): PaymentRequest {
  return {
    id: "req-a",
    contactTag: "cyphergirl",
    amount: 50.25,
    asset: "DAI",
    direction: "incoming",
    status: "pending",
    createdAt: NOW - 60_000,
    kind: "contact",
    ...overrides,
  }
}

describe("buildRequestRows", () => {
  it("maps a pending incoming contact request to a You-owe row", () => {
    const [row] = buildRequestRows([req({})], NOW)
    expect(row).toMatchObject({
      id: "req-a",
      kind: "incoming",
      counterparty: "@cyphergirl",
      contactTag: "cyphergirl",
      statusLabel: "You owe",
      amount: "-$50.25",
      amountValue: 50.25,
      direction: "out",
    })
  })

  it("maps a pending outgoing contact request to an Owes-you row", () => {
    const [row] = buildRequestRows(
      [req({ direction: "outgoing", contactTag: "theo", amount: 250 })],
      NOW,
    )
    expect(row).toMatchObject({
      kind: "outgoingContact",
      counterparty: "@theo",
      statusLabel: "Owes you",
      amount: "+$250.00",
      direction: "in",
    })
  })

  it("maps a pending outgoing link request to a Requested-via-link row", () => {
    const [row] = buildRequestRows(
      [req({ direction: "outgoing", kind: "link", contactTag: "", amount: 47.63 })],
      NOW,
    )
    expect(row).toMatchObject({
      kind: "outgoingLink",
      counterparty: "Requested via link",
      statusLabel: "Unpaid",
      amount: "+$47.63",
    })
    expect(row.contactTag).toBeUndefined()
  })

  it("labels a zero-amount link row 'Any amount'", () => {
    const [row] = buildRequestRows(
      [req({ direction: "outgoing", kind: "link", contactTag: "", amount: 0, amountAtomic: "0" })],
      NOW,
    )
    expect(row.amount).toBe("Any amount")
  })

  it("flags a link row 'Payment detected' once the linked deposit shows funds", () => {
    const request = req({
      direction: "outgoing",
      kind: "link",
      contactTag: "",
      sipaAddress: "0xAbC1",
    })
    // Evidence via balance, or via a phase past broadcast — either alone must flip the label.
    for (const deposit of [
      { sipaAddress: "0xabc1", phase: "broadcast" as const, amount: "12.5" },
      { sipaAddress: "0xabc1", phase: "sweeping" as const, amount: "0" },
    ]) {
      const [row] = buildRequestRows([request], NOW, [deposit])
      expect(row.statusLabel).toBe("Payment detected")
    }
  })

  it("keeps a link row 'Unpaid' with no deposit, an unfunded one, or another SIPA's", () => {
    const request = req({
      direction: "outgoing",
      kind: "link",
      contactTag: "",
      sipaAddress: "0xabc1",
    })
    expect(buildRequestRows([request], NOW)[0].statusLabel).toBe("Unpaid")
    expect(
      buildRequestRows([request], NOW, [
        { sipaAddress: "0xabc1", phase: "broadcast", amount: "0" },
      ])[0].statusLabel,
    ).toBe("Unpaid")
    expect(
      buildRequestRows([request], NOW, [
        { sipaAddress: "0xother", phase: "sweeping", amount: "9" },
      ])[0].statusLabel,
    ).toBe("Unpaid")
  })

  it("ignores deposits for contact rows", () => {
    const [row] = buildRequestRows([req({ direction: "outgoing", contactTag: "theo" })], NOW, [
      { sipaAddress: "0xabc1", phase: "sweeping", amount: "9" },
    ])
    expect(row.statusLabel).toBe("Owes you")
  })

  it("admits only pending, non-expired requests", () => {
    const rows = buildRequestRows(
      [
        req({ id: "ok" }),
        req({ id: "declined", status: "declined" }),
        req({ id: "fulfilled", status: "fulfilled" }),
        req({ id: "cancelled", status: "cancelled" }),
        req({ id: "expired", expiresAt: NOW - 1 }),
        req({ id: "not-yet-expired", expiresAt: NOW + 60_000 }),
      ],
      NOW,
    )
    expect(rows.map((r) => r.id)).toEqual(["ok", "not-yet-expired"])
  })
})

const TX = "0x" + "ab".repeat(32)
const OTHER = "0x" + "cd".repeat(32)
const L2 = "0x" + "11".repeat(32)
const SIPA = "0x" + "5a".repeat(20)

const alice: ContactRow = {
  id: "alice",
  name: "Alice",
  tag: "alice",
  address: L2,
  addressKind: "aztec-l2",
}

function directory(rows: ContactRow[]) {
  return {
    contacts: rows,
    lookup: (idOrTag: string) => rows.find((c) => c.id === idOrTag || c.tag === idOrTag),
  }
}

function receive(from: string, hash = TX, amount = 50.25): Transaction {
  return {
    action: "receive",
    status: "success",
    timestamp: NOW,
    txHash: hash,
    from,
    senderL2Address: L2,
    token: {
      address: "0x" + "aa".repeat(32),
      name: "DAI",
      symbol: "DAI",
      decimals: 18,
      logo: "",
      amount,
      price: 1,
    },
  }
}

function sipaDeposit(overrides: Partial<PaidLinkSipaDeposit> = {}): PaidLinkSipaDeposit {
  return {
    sipaAddress: SIPA,
    startTime: NOW - 30_000,
    endTime: NOW + 5_000,
    amount: "42",
    netAmount: "42000000000000000000",
    fee: "0",
    ...overrides,
  }
}

describe("buildPaidLinkRows", () => {
  it("projects fulfilled outgoing links only, timestamped at the SIPA settlement", () => {
    const [row, ...rest] = buildPaidLinkRows(
      [
        req({
          id: "paid",
          direction: "outgoing",
          kind: "link",
          status: "fulfilled",
          contactTag: "",
          sipaAddress: SIPA.toUpperCase(),
        }),
        req({ id: "pending-link", direction: "outgoing", kind: "link", contactTag: "" }),
        req({ id: "contact-paid", direction: "outgoing", status: "fulfilled" }),
      ],
      [sipaDeposit()],
    )
    expect(rest).toEqual([])
    expect(row).toMatchObject({
      id: "paid",
      counterparty: "Requested via link",
      timestampMs: NOW + 5_000,
    })
  })

  it("shows the deposit net for a SIPA-paid link, even on an any-amount link", () => {
    const [row] = buildPaidLinkRows(
      [
        req({
          direction: "outgoing",
          kind: "link",
          status: "fulfilled",
          contactTag: "",
          amount: 0,
          sipaAddress: SIPA,
        }),
      ],
      [sipaDeposit()],
    )
    expect(row.amount).toBe("+$42.00")
  })

  it("shows the verified receive's amount for an L2-paid link", () => {
    const [row] = buildPaidLinkRows(
      [
        req({
          direction: "outgoing",
          kind: "link",
          status: "fulfilled",
          contactTag: "",
          amount: 10,
          fulfillmentTxHash: TX,
        }),
      ],
      [],
      [receive("bob", TX, 15)],
    )
    expect(row.amount).toBe("+$15.00")
  })

  it("falls back to the requested amount and createdAt when nothing has landed locally", () => {
    const [row] = buildPaidLinkRows(
      [
        req({
          direction: "outgoing",
          kind: "link",
          status: "fulfilled",
          contactTag: "",
          amount: 0,
        }),
      ],
      [],
    )
    expect(row.amount).toBe("Any amount")
    expect(row.timestampMs).toBe(NOW - 60_000)
  })

  it("carries the fulfillment tx hash when present", () => {
    const [row] = buildPaidLinkRows(
      [
        req({
          direction: "outgoing",
          kind: "link",
          status: "fulfilled",
          contactTag: "",
          fulfillmentTxHash: "0xAbC",
        }),
      ],
      [],
    )
    expect(row.fulfillmentTxHash).toBe("0xAbC")
  })
})

describe("withoutPaidLinkReceives", () => {
  it("drops receives whose hash fulfills a paid link and keeps everything else", () => {
    const send: Transaction = { ...receive("bob", OTHER), action: "send" }
    const kept = withoutPaidLinkReceives(
      [receive("alice"), receive("bob", OTHER), send],
      [
        req({
          direction: "outgoing",
          kind: "link",
          status: "fulfilled",
          contactTag: "",
          fulfillmentTxHash: TX.toUpperCase(),
        }),
        req({
          id: "pending",
          direction: "outgoing",
          kind: "link",
          contactTag: "",
          fulfillmentTxHash: OTHER,
        }),
        req({
          id: "contact",
          direction: "outgoing",
          status: "fulfilled",
          fulfillmentTxHash: OTHER,
        }),
      ],
    )
    expect(kept.map((tx) => tx.txHash)).toEqual([OTHER, OTHER])
    expect(kept.map((tx) => tx.action)).toEqual(["receive", "send"])
  })

  it("is a no-op when no request fulfills anything", () => {
    const txs = [receive("alice")]
    expect(withoutPaidLinkReceives(txs, [])).toEqual(txs)
  })
})

describe("requests from non-contacts", () => {
  const row = (tag: string, addressKind: ContactRow["addressKind"] = "aztec-l2"): ContactRow => ({
    id: tag,
    name: tag,
    tag,
    address: "0x01",
    addressKind,
  })

  it("counts only L2 contacts the user added, by lowercased tag", () => {
    const fromTransfer = { ...row("jo"), autoAdded: true }
    expect(
      approvedContactTags([row("Ada"), row("0x5a7e…71a1", "ethereum-l1"), fromTransfer]),
    ).toEqual(new Set(["ada"]))
  })

  it("flags incoming requests from outside the contact book only", () => {
    const tags = new Set(["ada"])
    expect(isFromNonContact(req({ contactTag: "Ada" }), tags)).toBe(false)
    expect(isFromNonContact(req({ contactTag: "mina" }), tags)).toBe(true)
    expect(isFromNonContact(req({ contactTag: "mina", direction: "outgoing" }), tags)).toBe(false)
  })

  it("lists pending, unexpired non-contact requests, newest first", () => {
    const rows = nonContactInbox(
      [
        req({ id: "old", contactTag: "mina", createdAt: NOW - 3_000 }),
        req({ id: "new", contactTag: "paul", createdAt: NOW - 1_000 }),
        req({ id: "contact", contactTag: "ada" }),
        req({ id: "declined", contactTag: "mina", status: "declined" }),
        req({ id: "expired", contactTag: "mina", expiresAt: NOW - 1 }),
      ],
      [],
      new Set(["ada"]),
      NOW,
    )
    expect(rows.map((r) => r.id)).toEqual(["new", "old"])
  })

  it.each(["pending", "success"] as const)(
    "leaves out a request a %s send answered, and offers it again once the send failed",
    (status) => {
      const request = req({ contactTag: "mina" })
      const answer = { action: "send", requestId: "req-a" } as const
      expect(nonContactInbox([request], [{ ...answer, status }], new Set(), NOW)).toEqual([])
      expect(nonContactInbox([request], [{ ...answer, status: "failed" }], new Set(), NOW)).toEqual(
        [request],
      )
    },
  )
})

describe("withoutAnsweredRequests", () => {
  const send = (status: "pending" | "success" | "failed", requestId?: string) =>
    ({ action: "send", status, requestId } as const)

  it("hides a pending incoming request while its send is pending", () => {
    expect(withoutAnsweredRequests([req({})], [send("pending", "REQ-A")])).toEqual([])
  })

  // A send the wallet stopped watching mid-flight marks nothing when it lands, so the row is all
  // that speaks for it; re-offering the payment there is how someone pays twice.
  it("keeps hiding the request once its send has landed", () => {
    expect(withoutAnsweredRequests([req({})], [send("success", "req-a")])).toEqual([])
  })

  it("lets the request reappear when the send failed, and ignores other sends", () => {
    const rows = [req({})]
    expect(withoutAnsweredRequests(rows, [send("failed", "req-a")])).toEqual(rows)
    expect(withoutAnsweredRequests(rows, [send("pending", "req-b"), send("pending")])).toEqual(rows)
  })

  it("never hides outgoing rows", () => {
    const rows = [req({ direction: "outgoing" })]
    expect(withoutAnsweredRequests(rows, [send("pending", "req-a")])).toEqual(rows)
  })
})

describe("payerForPaidLink", () => {
  const paid = req({
    direction: "outgoing",
    kind: "link",
    status: "fulfilled",
    contactTag: "",
    fulfillmentTxHash: TX,
  })

  it("resolves a saved contact name from the matching receive", () => {
    expect(payerForPaidLink(paid, [receive("alice")], directory([alice]))).toEqual({
      displayName: "Alice",
      contact: alice,
    })
  })

  it("falls back to @tag when the sender is unsaved", () => {
    expect(payerForPaidLink(paid, [receive("bob")], directory([]))).toEqual({
      displayName: "@bob",
      contact: undefined,
    })
  })

  it("returns undefined when the receive has not landed (SIPA / in-flight)", () => {
    expect(payerForPaidLink(paid, [], directory([]))).toBeUndefined()
    expect(
      payerForPaidLink({ fulfillmentTxHash: undefined }, [receive("alice")], directory([])),
    ).toBeUndefined()
  })
})

import { describe, expect, it } from "vitest"
import { Network } from "@obsidion/sdk"
import { l2TxUrl } from "../src/lib/explorer"
import type {
  Contact,
  PaymentRequest,
  SIPADepositRecord,
  Transaction,
  WithdrawalRecord,
} from "@obsidion/front-core"
import {
  bubbleViewOf,
  buildContactChat,
  chatMessageSource,
  selectedContactOf,
} from "../src/features/contacts/contactChat"

const L2_ADDR = "0x" + "a".repeat(64)
const ETH_ADDR = "0x" + "1".repeat(40)

const l2Entry: Contact = { name: "Maria", tag: "maria", address: L2_ADDR, verified: true }

const l1Entry: Contact = {
  name: "Rainbow Wallet",
  address: ETH_ADDR,
  addressKind: "ethereum-l1",
  l1Wallet: { provider: "rainbow", provenance: "deposit-attested" },
} as Contact

const pendingEntry: Contact = {
  name: "theo",
  tag: "theo",
  address: "xmtp:0xdeadbeef",
  addressKind: "pending-handshake",
} as Contact

function tokenTx(overrides: {
  action: "send" | "receive"
  status?: "pending" | "success" | "failed"
  to?: string
  from?: string
  amount?: number
  timestamp?: number
  txHash?: string
}): Transaction {
  return {
    timestamp: overrides.timestamp ?? 1_700_000_000_000,
    status: overrides.status ?? "success",
    txHash: overrides.txHash ?? "0xtxhash",
    action: overrides.action,
    token: { amount: overrides.amount ?? 5 } as any,
    to: overrides.to,
    from: overrides.from,
  } as unknown as Transaction
}

function request(overrides: Partial<PaymentRequest>): PaymentRequest {
  return {
    id: "req-1",
    contactTag: "maria",
    amount: 10,
    asset: "DAI",
    direction: "outgoing",
    status: "pending",
    createdAt: 1_700_000_000_000,
    ...overrides,
  }
}

function sipaDeposit(overrides: Partial<SIPADepositRecord>): SIPADepositRecord {
  return {
    sipaAddress: "0x00000000000000000000000000000000000000aa",
    recipientL2Address: L2_ADDR,
    messageSecret: "0x01",
    recipientHash: "0x02",
    recoveryAddress: "0x0000000000000000000000000000000000000003",
    l1ChainId: 1,
    amount: "10",
    // Priced, so the row can read as a credit: an unpriced deposit shows its gross unsigned.
    fee: "250000000000000000",
    fpcFundingCut: "0",
    tokenSymbol: "DAI",
    walletAddress: ETH_ADDR,
    phase: "claimed",
    startTime: 1_700_000_000_000,
    ...overrides,
  } as SIPADepositRecord
}

function withdrawal(overrides: Partial<WithdrawalRecord>): WithdrawalRecord {
  return {
    localId: "wdraw_1",
    recipient: ETH_ADDR,
    recipientProvenance: "deposit-attested",
    amount: "4",
    tokenSymbol: "DAI",
    phase: "done",
    startTime: 1_700_000_001_000,
    l2TxHash: "0xburn",
    ...overrides,
  } as WithdrawalRecord
}

describe("selectedContactOf", () => {
  it("maps a tagged L2 entry with the directory row identity", () => {
    expect(selectedContactOf(l2Entry)).toMatchObject({
      id: "maria",
      name: "Maria",
      tag: "maria",
      address: L2_ADDR,
      addressKind: "aztec-l2",
    })
  })

  it("maps an L1 wallet entry with the l1:<provider>:<address> id", () => {
    const selected = selectedContactOf(l1Entry)
    expect(selected.id).toBe(`l1:rainbow:${ETH_ADDR.toLowerCase()}`)
    expect(selected.addressKind).toBe("ethereum-l1")
    expect(selected.address).toBe(ETH_ADDR)
  })

  it("maps a pending-handshake entry tag-only, with no payable address", () => {
    const selected = selectedContactOf(pendingEntry)
    expect(selected.tag).toBe("theo")
    expect(selected.address).toBeUndefined()
    expect(selected.addressKind).toBe("aztec-l2")
  })
})

describe("l2TxUrl", () => {
  it("uses the public explorers for mainnet and testnet", () => {
    expect(l2TxUrl(Network.MAINNET, "http://localhost:8080", "0xabc")).toBe(
      "https://aztecscan.xyz/tx-effects/0xabc",
    )
    expect(l2TxUrl(Network.TESTNET, "http://localhost:8080", "0xabc")).toBe(
      "https://testnet.aztecscan.xyz/tx-effects/0xabc",
    )
  })

  it("routes sandbox at the local node", () => {
    expect(l2TxUrl(Network.SANDBOX, "http://localhost:8080", "0xabc")).toBe(
      "http://localhost:8080/tx-effects/0xabc",
    )
  })
})

describe("buildContactChat", () => {
  const txUrl = (hash: string) => `https://l2.example/tx/${hash}`

  it("merges transactions and requests for an L2 contact in timestamp order", () => {
    const t0 = 1_700_000_000_000
    const messages = buildContactChat(
      l2Entry,
      {
        transactions: [tokenTx({ action: "send", to: L2_ADDR, timestamp: t0 + 2_000 })],
        requests: [request({ createdAt: t0 })],
      },
      txUrl,
    )
    expect(messages.map((m) => m.id)).toEqual(["req-1", "0xtxhash"])
    expect(messages.map((m) => m.role)).toEqual(["request-out", "sent-confirmed"])
  })

  it("renders an incoming pending request as a request-in chat row, and hides it once declined", () => {
    const pending = buildContactChat(
      l2Entry,
      { requests: [request({ direction: "incoming" })] },
      txUrl,
    )
    expect(pending.map((m) => ({ id: m.id, role: m.role }))).toEqual([
      { id: "req-1", role: "request-in" },
    ])

    const declined = buildContactChat(
      l2Entry,
      { requests: [request({ direction: "incoming", status: "declined" })] },
      txUrl,
    )
    expect(declined).toHaveLength(0)
  })

  it("renders SIPA deposits and matching withdrawals for an L1 contact", () => {
    const messages = buildContactChat(
      l1Entry,
      {
        sipaDeposits: [sipaDeposit({})],
        withdrawals: [withdrawal({})],
      },
      txUrl,
    )
    expect(messages.map((m) => m.role)).toEqual(["received-confirmed", "sent-confirmed"])
    expect(messages[0].amount.startsWith("+$")).toBe(true)
    expect(messages[1].amount.startsWith("-$")).toBe(true)
    expect(messages[1].explorerUrl).toBe("https://l2.example/tx/0xburn")
  })

  it("omits a withdrawal whose recipient does not match the L1 contact", () => {
    const messages = buildContactChat(
      l1Entry,
      { withdrawals: [withdrawal({ recipient: `0x${"2".repeat(40)}` })] },
      txUrl,
    )
    expect(messages).toHaveLength(0)
  })

  it("threads the explorer URL onto on-chain tx rows", () => {
    const messages = buildContactChat(
      l2Entry,
      { transactions: [tokenTx({ action: "send", to: L2_ADDR, txHash: "0xfeed" })] },
      txUrl,
    )
    expect(messages[0].explorerUrl).toBe("https://l2.example/tx/0xfeed")
  })

  it("shows a pending-handshake contact's chat as empty for tx sources", () => {
    const messages = buildContactChat(pendingEntry, {
      transactions: [tokenTx({ action: "send", to: "xmtp:0xdeadbeef" })],
    })
    expect(messages).toEqual([])
  })
})

describe("chatMessageSource", () => {
  it("opens a fulfilled request's stand-in bubble as the request, not a transaction", () => {
    const sources = { requests: [request({ status: "fulfilled", fulfillmentTxHash: "0xpaid" })] }
    const [bubble] = buildContactChat(l2Entry, sources)
    expect(bubble.role).toBe("received-confirmed")
    expect(chatMessageSource(bubble, sources)).toEqual({ kind: "request", id: "req-1" })
  })

  it("resolves transfers, deposits and withdrawals by the id their bubble carries", () => {
    const tx = tokenTx({ action: "receive", from: L2_ADDR })
    const l2 = { transactions: [tx], requests: [request({ createdAt: 1_700_000_001_000 })] }
    const [transfer, req] = buildContactChat(l2Entry, l2)
    expect(chatMessageSource(req, l2)).toEqual({ kind: "request", id: "req-1" })
    expect(chatMessageSource(transfer, l2)).toEqual({ kind: "transaction", transaction: tx })

    const l1 = { sipaDeposits: [sipaDeposit({})], withdrawals: [withdrawal({})] }
    const [deposit, burn] = buildContactChat(l1Entry, l1)
    expect(chatMessageSource(deposit, l1)).toEqual({ kind: "deposit", record: l1.sipaDeposits[0] })
    expect(chatMessageSource(burn, l1)).toEqual({ kind: "withdrawal", record: l1.withdrawals[0] })
  })

  it("falls back to the queue id and then the timestamp for an unhashed transfer", () => {
    const queued = {
      ...tokenTx({ action: "send", to: L2_ADDR, status: "pending" }),
      txHash: undefined,
      queueId: "q-1",
    }
    const bare = {
      ...tokenTx({ action: "send", to: L2_ADDR, timestamp: 1_700_000_005_000 }),
      txHash: undefined,
    }
    const sources = { transactions: [queued, bare] as unknown as Transaction[] }
    const [first, second] = buildContactChat(l2Entry, sources)
    expect(chatMessageSource(first, sources)?.kind).toBe("transaction")
    expect(chatMessageSource(second, sources)?.kind).toBe("transaction")
    expect(chatMessageSource({ ...first, id: "nope" }, sources)).toBeUndefined()
  })
})

describe("bubbleViewOf", () => {
  it("aligns received and incoming-request bubbles left, sent and outgoing-request right", () => {
    expect(bubbleViewOf("received-confirmed").side).toBe("left")
    expect(bubbleViewOf("request-in").side).toBe("left")
    expect(bubbleViewOf("request-declined").side).toBe("left")
    expect(bubbleViewOf("sent-pending").side).toBe("right")
    expect(bubbleViewOf("request-out").side).toBe("right")
  })

  it("labels each role", () => {
    expect(bubbleViewOf("received-confirmed").label).toBe("Received")
    expect(bubbleViewOf("sent-confirmed").label).toBe("Sent")
    expect(bubbleViewOf("request-out").label).toBe("Owes you")
    expect(bubbleViewOf("request-in").label).toBe("You owe")
    expect(bubbleViewOf("request-declined").label).toBe("Declined")
    expect(bubbleViewOf("sent-pending").label).toBe("Pending")
  })

  it("sides outgoing right, tints declined red + struck", () => {
    expect(bubbleViewOf("sent-confirmed").side).toBe("right")
    expect(bubbleViewOf("request-out").side).toBe("right")
    expect(bubbleViewOf("received-confirmed").side).toBe("left")
    expect(bubbleViewOf("request-declined")).toMatchObject({ error: true, struck: true })
    expect(bubbleViewOf("sent-failed")).toMatchObject({ error: true, struck: true })
    expect(bubbleViewOf("sent-confirmed")).toMatchObject({ struck: false, tick: "mined" })
  })

  it("marks a send the way the tx itself moves: spinner, one tick, two", () => {
    expect(bubbleViewOf("sent-proving").tick).toBe("proving")
    expect(bubbleViewOf("sent-pending").tick).toBe("sent")
    expect(bubbleViewOf("sent-confirmed").tick).toBe("mined")
    // Nothing to mark on a transfer that never landed, or on an open request.
    expect(bubbleViewOf("sent-failed").tick).toBe("none")
    expect(bubbleViewOf("request-out").tick).toBe("none")
  })
})

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import { QueueStatus } from "@obsidion/sdk"
import {
  buildChatMessages as buildChatMessagesCore,
  buildContactPayload,
  DETECTING_AMOUNT,
  formatDateLabel,
  formatTimeLabel,
  type BuildChatMessageSources,
  type PaymentRequest,
  type SelectedContact,
  type SIPADepositRecord,
  type Transaction,
  type WithdrawalRecord,
} from "../src/index.js"

// Explorer-URL building is injected; fixtures bind a fake.
const txUrl = (hash: string) => `https://l2.example/tx/${hash}`
const buildChatMessages = (contact: SelectedContact | null, sources?: BuildChatMessageSources) =>
  buildChatMessagesCore(contact, sources, txUrl)

const MARIA_ADDRESS = "0x15b7a9a3d3685e053bffec6bd35dfeb4beb2616831a8e93b65c0493bcb5b4138"
const THEO_ADDRESS = "0x2cb424c9829710e462cbfe9b65e168be6d88eda507dd3e8a1b38b56f4df3cb12"

const maria: SelectedContact = {
  id: "maria",
  name: "Maria Teixeira",
  tag: "maria",
  address: MARIA_ADDRESS,
  addressKind: "aztec-l2",
}

const l1Wallet: SelectedContact = {
  id: `l1:${MARIA_ADDRESS.toLowerCase()}`,
  name: "Maria Wallet",
  tag: "0x15b7...b4138",
  address: MARIA_ADDRESS,
  addressKind: "ethereum-l1",
}

function tokenTx(overrides: {
  action: "send" | "receive"
  status?: "pending" | "success" | "failed"
  to?: string
  from?: string
  senderL2Address?: string
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
    senderL2Address: overrides.senderL2Address,
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
    recipientL2Address: THEO_ADDRESS,
    messageSecret: "0x01",
    recipientHash: "0x02",
    recoveryAddress: "0x0000000000000000000000000000000000000003",
    l1ChainId: 1,
    amount: "10",
    tokenSymbol: "DAI",
    walletAddress: MARIA_ADDRESS,
    phase: "claimed",
    startTime: 1_700_000_000_000,
    ...overrides,
  } as SIPADepositRecord
}

function withdrawal(overrides: Partial<WithdrawalRecord>): WithdrawalRecord {
  return {
    localId: "withdraw-local",
    recipient: MARIA_ADDRESS,
    recipientProvenance: "deposit-attested",
    amount: "4",
    tokenSymbol: "DAI",
    phase: "done",
    startTime: 1_700_000_001_000,
    ...overrides,
  } as WithdrawalRecord
}

describe("buildChatMessages", () => {
  it("returns empty array when contact is null", () => {
    expect(buildChatMessages(null)).toEqual([])
  })

  it("returns empty array when contact has no transactions or requests", () => {
    expect(buildChatMessages(maria)).toEqual([])
  })

  it("maps an outgoing send (success) to sent-confirmed with negative amount", () => {
    const tx = tokenTx({ action: "send", status: "success", to: MARIA_ADDRESS, amount: 5 })
    const result = buildChatMessages(maria, { transactions: [tx] })
    expect(result).toHaveLength(1)
    expect(result[0].role).toBe("sent-confirmed")
    expect(result[0].amount).toBe("-$5.00")
  })

  it("maps a pending outgoing send to sent-pending and timeLabel='Pending'", () => {
    const tx = tokenTx({
      action: "send",
      status: QueueStatus.PENDING as unknown as "pending",
      to: MARIA_ADDRESS,
    })
    const result = buildChatMessages(maria, { transactions: [tx] })
    expect(result[0].role).toBe("sent-pending")
    expect(result[0].timeLabel).toBe("Pending")
  })

  it("maps a pending send with no hash to sent-proving — nothing is in a mempool yet", () => {
    const tx = tokenTx({ action: "send", status: "pending", to: MARIA_ADDRESS, txHash: "" })
    const result = buildChatMessages(maria, { transactions: [tx] })
    expect(result[0].role).toBe("sent-proving")
    expect(result[0].timeLabel).toBe("Proving")
  })

  it("maps an incoming receive (success) to received-confirmed with positive amount", () => {
    const tx = tokenTx({
      action: "receive",
      status: "success",
      from: MARIA_ADDRESS,
      amount: 3,
    })
    const result = buildChatMessages(maria, { transactions: [tx] })
    expect(result[0].role).toBe("received-confirmed")
    expect(result[0].amount).toBe("+$3.00")
  })

  it("maps an outgoing pending request to request-out with formatted timeLabel (not 'Pending')", () => {
    const r = request({
      direction: "outgoing",
      amount: 12.5,
      createdAt: Date.UTC(2026, 1, 3, 11, 15),
    })
    const result = buildChatMessages(maria, { requests: [r] })
    expect(result).toHaveLength(1)
    expect(result[0].role).toBe("request-out")
    expect(result[0].timeLabel).toMatch(/^\d{2}:\d{2}$/)
    expect(result[0].timeLabel).not.toBe("Pending")
    expect(result[0].amount).toBe("-$12.50")
  })

  it("renders fulfilled→received-confirmed and declined→request-declined, drops cancelled", () => {
    const cancelled = request({ id: "r-cancelled", direction: "outgoing", status: "cancelled" })
    const declined = request({ id: "r-declined", direction: "outgoing", status: "declined" })
    const fulfilled = request({ id: "r-fulfilled", direction: "outgoing", status: "fulfilled" })
    const pending = request({ id: "r-pending", direction: "outgoing", status: "pending" })
    const result = buildChatMessages(maria, {
      requests: [cancelled, declined, fulfilled, pending],
    })
    const roleById = Object.fromEntries(result.map((m) => [m.id, m.role]))
    expect(result).toHaveLength(3)
    expect(roleById["r-cancelled"]).toBeUndefined()
    expect(roleById["r-pending"]).toBe("request-out")
    expect(roleById["r-fulfilled"]).toBe("received-confirmed")
    expect(roleById["r-declined"]).toBe("request-declined")
  })

  it("renders incoming requests: pending→request-in, fulfilled→request-paid (unsigned), drops declined", () => {
    const pending = request({ id: "r-in-pending", direction: "incoming", status: "pending" })
    const paid = request({
      id: "r-in-paid",
      direction: "incoming",
      status: "fulfilled",
      amount: 12.5,
    })
    const declined = request({ id: "r-in-declined", direction: "incoming", status: "declined" })
    const result = buildChatMessages(maria, { requests: [pending, paid, declined] })
    const byId = Object.fromEntries(result.map((m) => [m.id, m]))
    expect(result).toHaveLength(2)
    expect(byId["r-in-pending"].role).toBe("request-in")
    expect(byId["r-in-paid"].role).toBe("request-paid")
    expect(byId["r-in-paid"].amount).toBe("$12.50")
    expect(byId["r-in-declined"]).toBeUndefined()
  })

  it("hides a fulfilled outgoing request when its fulfilling transaction renders in the chat", () => {
    // The fulfilled row records the fulfilling transfer's hash (fulfillmentTxHash),
    // and the transfer itself renders in the chat (same txHash). The
    // transaction bubble takes precedence — the request row must not render.
    const fulfilled = request({
      id: "r-paid",
      status: "fulfilled",
      fulfillmentTxHash: "0xpay",
      createdAt: 1000,
    })
    const payingTx = tokenTx({
      action: "receive",
      from: "maria",
      senderL2Address: MARIA_ADDRESS,
      txHash: "0xpay",
      timestamp: 2000,
    })
    const result = buildChatMessages(maria, { transactions: [payingTx], requests: [fulfilled] })
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe("0xpay")
    expect(result[0].role).toBe("received-confirmed")
  })

  it("keeps the fulfilled request bubble when the fulfilling transaction is not in the chat", () => {
    const fulfilled = request({
      id: "r-paid-early",
      status: "fulfilled",
      fulfillmentTxHash: "0xnot-arrived",
    })
    const unrelatedTx = tokenTx({ action: "receive", from: MARIA_ADDRESS, txHash: "0xother" })
    const result = buildChatMessages(maria, {
      transactions: [unrelatedTx],
      requests: [fulfilled],
    })
    expect(result.map((m) => m.id)).toContain("r-paid-early")
    expect(result.find((m) => m.id === "r-paid-early")?.role).toBe("received-confirmed")
  })

  it("filters out requests for a different contact tag (case-insensitive match)", () => {
    const forMaria = request({ id: "r-maria", contactTag: "MARIA" })
    const forTheo = request({ id: "r-theo", contactTag: "theo" })
    const result = buildChatMessages(maria, { requests: [forMaria, forTheo] })
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe("r-maria")
  })

  it("filters out transactions without a token field", () => {
    const noToken = {
      timestamp: 1,
      status: "success",
      txHash: "0x",
      action: "send",
      to: MARIA_ADDRESS,
    } as unknown as Transaction
    const withToken = tokenTx({ action: "send", to: MARIA_ADDRESS })
    const result = buildChatMessages(maria, { transactions: [noToken, withToken] })
    expect(result).toHaveLength(1)
  })

  it("filters out transactions whose to/from does not match the contact's address", () => {
    const forMaria = tokenTx({ action: "send", to: MARIA_ADDRESS, txHash: "0xa" })
    const forTheo = tokenTx({ action: "send", to: THEO_ADDRESS, txHash: "0xb" })
    const result = buildChatMessages(maria, { transactions: [forMaria, forTheo] })
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe("0xa")
  })

  it("matches XMTP-received transfers via senderL2Address when from is a tag", () => {
    // The transfer scanner writes the sender's tag into `from` and the canonical
    // L2 address into `senderL2Address` — the contact's stored address must
    // match the latter for the receive to land in chat history.
    const xmtpReceive = tokenTx({
      action: "receive",
      from: "maria",
      senderL2Address: MARIA_ADDRESS,
      txHash: "0xxmtp",
    })
    const result = buildChatMessages(maria, { transactions: [xmtpReceive] })
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe("0xxmtp")
    expect(result[0].role).toBe("received-confirmed")
  })

  it("returns empty array when the contact has no address", () => {
    const tx = tokenTx({ action: "send", to: MARIA_ADDRESS })
    const r = request({ status: "pending" })
    const noAddress: SelectedContact = { ...maria, address: undefined }
    // Requests still match by tag, but transactions are skipped without an address.
    const result = buildChatMessages(noAddress, { transactions: [tx], requests: [r] })
    expect(result).toHaveLength(1)
    expect(result[0].role).toBe("request-out")
  })

  it("merges and sorts transactions and requests by timestamp ascending", () => {
    const oldTx = tokenTx({ action: "send", to: MARIA_ADDRESS, timestamp: 1000, txHash: "0xold" })
    const midRequest = request({ id: "r-mid", createdAt: 2000 })
    const newTx = tokenTx({ action: "send", to: MARIA_ADDRESS, timestamp: 3000, txHash: "0xnew" })
    const result = buildChatMessages(maria, {
      transactions: [newTx, oldTx],
      requests: [midRequest],
    })
    expect(result.map((m) => m.id)).toEqual(["0xold", "r-mid", "0xnew"])
  })

  it("uses txHash, then queueId, then timestamp string as message id", () => {
    const withHash = tokenTx({
      action: "send",
      to: MARIA_ADDRESS,
      txHash: "0xhash",
      timestamp: 1000,
    })
    const withQueue = {
      ...tokenTx({ action: "send", to: MARIA_ADDRESS, txHash: "", timestamp: 2000 }),
      queueId: "queue-1",
    } as Transaction
    const noHashOrQueue = tokenTx({
      action: "send",
      to: MARIA_ADDRESS,
      txHash: "",
      timestamp: 3000,
    })
    const result = buildChatMessages(maria, { transactions: [withHash, withQueue, noHashOrQueue] })
    expect(result.map((m) => m.id)).toEqual(["0xhash", "queue-1", "3000"])
  })

  it("links transfers with a real txHash via the injected txUrl; hash-less rows and requests get none", () => {
    const result = buildChatMessages(maria, {
      transactions: [
        tokenTx({ action: "send", to: MARIA_ADDRESS, txHash: "0xhash", timestamp: 1000 }),
        tokenTx({ action: "send", to: MARIA_ADDRESS, txHash: "", timestamp: 2000 }),
      ],
      requests: [request({ id: "r-1", createdAt: 3000 })],
    })
    expect(result.map((m) => m.explorerUrl)).toEqual([
      "https://l2.example/tx/0xhash",
      undefined,
      undefined,
    ])
  })

  it("renders no explorer links when txUrl is not injected", () => {
    const result = buildChatMessagesCore(maria, {
      transactions: [tokenTx({ action: "send", to: MARIA_ADDRESS, txHash: "0xhash" })],
    })
    expect(result.map((m) => m.explorerUrl)).toEqual([undefined])
  })

  it("links a withdrawal chat message to the L2 explorer for its burn tx", () => {
    const result = buildChatMessages(l1Wallet, {
      bridge: { withdrawals: [withdrawal({ l2TxHash: "0xburn" })] },
    })
    expect(result.map((m) => m.explorerUrl)).toEqual(["https://l2.example/tx/0xburn"])
  })

  it("maps failed L2 token transfers to failed transfer roles", () => {
    const failedSend = tokenTx({
      action: "send",
      status: "failed",
      to: MARIA_ADDRESS,
      txHash: "0xfailed-send",
    })
    const failedReceive = tokenTx({
      action: "receive",
      status: "failed",
      from: MARIA_ADDRESS,
      txHash: "0xfailed-receive",
      timestamp: 1_700_000_000_500,
    })

    const result = buildChatMessages(maria, { transactions: [failedSend, failedReceive] })

    expect(result.map((m) => m.role)).toEqual(["sent-failed", "received-failed"])
    expect(result.map((m) => m.timeLabel)).toEqual(["Failed", "Failed"])
  })

  it("accepts paylink chat sources through an explicit source slot", () => {
    const result = buildChatMessages(maria, {
      paylinks: [
        {
          id: "paylink-1",
          contactTag: "maria",
          amount: "7.5",
          direction: "outgoing",
          status: "failed",
          createdAt: 1_700_000_001_000,
        },
      ],
    })

    expect(result).toEqual([
      expect.objectContaining({
        id: "paylink-1",
        amount: "-$7.50",
        role: "sent-failed",
        timeLabel: "Failed",
      }),
    ])
  })

  it("renders SIPA deposits in the sender-wallet thread with phase-true labels", () => {
    const result = buildChatMessages(l1Wallet, {
      bridge: {
        sipaDeposits: [
          // resolved = nothing observable yet — hidden like awaiting_funds
          sipaDeposit({
            sipaAddress: "0x00000000000000000000000000000000000000a0",
            phase: "resolved",
          }),
          sipaDeposit({
            sipaAddress: "0x00000000000000000000000000000000000000a1",
            phase: "claimed",
            amount: "12.5",
            fee: "250000000000000000",
            fpcFundingCut: "0",
            startTime: 1_700_000_000_000,
          }),
          sipaDeposit({
            sipaAddress: "0x00000000000000000000000000000000000000a2",
            phase: "recoverable",
            startTime: 1_700_000_100_000,
          }),
          sipaDeposit({
            sipaAddress: "0x00000000000000000000000000000000000000a3",
            phase: "recovered",
            startTime: 1_700_000_200_000,
          }),
          // other wallet's deposit — filtered out of this thread
          sipaDeposit({
            sipaAddress: "0x00000000000000000000000000000000000000a4",
            phase: "claimed",
            walletAddress: THEO_ADDRESS,
          }),
        ],
      },
    })

    expect(result).toEqual([
      expect.objectContaining({
        id: "0x00000000000000000000000000000000000000a1",
        amount: "+$12.25",
        role: "received-confirmed",
      }),
      expect.objectContaining({
        id: "0x00000000000000000000000000000000000000a2",
        amount: "$10.00",
        role: "received-pending",
        timeLabel: "Needs recovery",
      }),
      expect.objectContaining({
        id: "0x00000000000000000000000000000000000000a3",
        role: "received-cancelled",
        timeLabel: "Recovered",
      }),
    ])
  })

  it("shows a recovered SIPA deposit as an unsigned gross amount, never a credit", () => {
    const result = buildChatMessages(l1Wallet, {
      bridge: {
        sipaDeposits: [
          sipaDeposit({
            phase: "recovered",
            amount: "100",
            fee: "250000000000000000",
            fpcFundingCut: "0",
          }),
        ],
      },
    })
    expect(result).toEqual([
      expect.objectContaining({ amount: "$100.00", role: "received-cancelled" }),
    ])
  })

  it("shows an over-cap recoverable deposit as an unsigned gross amount, still pending", () => {
    const result = buildChatMessages(l1Wallet, {
      bridge: {
        sipaDeposits: [
          sipaDeposit({
            phase: "recoverable",
            amount: "5000",
            fee: "250000000000000000",
            fpcFundingCut: "0",
          }),
        ],
      },
    })
    expect(result).toEqual([
      expect.objectContaining({
        amount: "$5000.00",
        role: "received-pending",
        timeLabel: "Needs recovery",
      }),
    ])
  })

  it("shows a sub-fee recoverable deposit as its gross, not a +$0 credit", () => {
    const result = buildChatMessages(l1Wallet, {
      bridge: {
        sipaDeposits: [
          sipaDeposit({
            phase: "recoverable",
            amount: "0.1",
            fee: "250000000000000000",
            fpcFundingCut: "0",
          }),
        ],
      },
    })
    expect(result).toEqual([expect.objectContaining({ amount: "$0.10", role: "received-pending" })])
  })

  it("shows a priced deposit whose net is zero as its gross, unsigned", () => {
    const result = buildChatMessages(l1Wallet, {
      bridge: {
        sipaDeposits: [
          // 0.2 sent against a 0.35 fee: the amount is read, the credit is nothing.
          sipaDeposit({
            phase: "sweeping",
            amount: "0.2",
            fee: "350000000000000000",
            fpcFundingCut: "0",
          }),
        ],
      },
    })
    expect(result).toEqual([expect.objectContaining({ amount: "$0.20" })])
  })

  it("says the amount is still being detected when a crediting phase has no gross", () => {
    const result = buildChatMessages(l1Wallet, {
      bridge: {
        sipaDeposits: [sipaDeposit({ phase: "broadcast", amount: "0" })],
      },
    })
    expect(result).toEqual([expect.objectContaining({ amount: DETECTING_AMOUNT })])
  })

  it("shows the net (gross - fee) for a SIPA deposit with a persisted fee", () => {
    const result = buildChatMessages(l1Wallet, {
      bridge: {
        sipaDeposits: [
          sipaDeposit({
            sipaAddress: "0x00000000000000000000000000000000000000b1",
            phase: "funded",
            amount: "100",
            fee: "250000000000000000",
            fpcFundingCut: "0",
          }),
        ],
      },
    })
    expect(result).toEqual([expect.objectContaining({ amount: "+$99.75" })])
  })

  it("shows an unpriced deposit as its gross, so no bubble credits the unread fee", () => {
    const result = buildChatMessages(l1Wallet, {
      bridge: {
        sipaDeposits: [sipaDeposit({ phase: "claimed", amount: "100" })],
      },
    })
    expect(result).toEqual([
      expect.objectContaining({ amount: "$100.00", role: "received-confirmed" }),
    ])
  })

  it("maps a done L1 withdrawal into the recipient's contact chat as sent-confirmed", () => {
    const result = buildChatMessages(l1Wallet, {
      bridge: {
        withdrawals: [withdrawal({ amount: "3.25", startTime: 2000, l2TxHash: "0xwithdraw" })],
      },
    })

    expect(result.map((m) => m.role)).toEqual(["sent-confirmed"])
    expect(result.map((m) => m.amount)).toEqual(["-$3.25"])
    expect(result.map((m) => m.id)).toEqual(["0xwithdraw"])
  })

  it("marks an in-flight L1 withdrawal as pending", () => {
    const result = buildChatMessages(l1Wallet, {
      bridge: { withdrawals: [withdrawal({ phase: "awaiting_proven" })] },
    })

    expect(result.map((m) => m.role)).toEqual(["sent-pending"])
    expect(result.map((m) => m.timeLabel)).toEqual(["Pending"])
  })

  it("keeps a failed L1 withdrawal visible with a failed transfer role", () => {
    const result = buildChatMessages(l1Wallet, {
      bridge: { withdrawals: [withdrawal({ phase: "failed", startTime: 2000 })] },
    })

    expect(result.map((m) => m.role)).toEqual(["sent-failed"])
    expect(result.map((m) => m.timeLabel)).toEqual(["Failed"])
  })

  it("filters L1 withdrawals by recipient address", () => {
    const result = buildChatMessages(l1Wallet, {
      bridge: {
        withdrawals: [
          withdrawal({ localId: "for-maria" }),
          withdrawal({ localId: "for-theo", recipient: THEO_ADDRESS }),
        ],
      },
    })

    expect(result.map((m) => m.id)).toEqual(["for-maria"])
  })
})

describe("buildContactPayload", () => {
  const colors = (): [string, string] => ["#111111", "#222222"]

  it("formats L2 contact handles as zk.money tags", () => {
    expect(buildContactPayload(maria, colors)).toMatchObject({
      id: "maria",
      name: "Maria Teixeira",
      tag: "@maria.zk.money",
      address: MARIA_ADDRESS,
      addressKind: "aztec-l2",
    })
  })

  it("formats L1 contact handles as raw addresses", () => {
    expect(buildContactPayload(l1Wallet, colors)).toMatchObject({
      id: `l1:${MARIA_ADDRESS.toLowerCase()}`,
      name: "Maria Wallet",
      tag: MARIA_ADDRESS,
      address: MARIA_ADDRESS,
      addressKind: "ethereum-l1",
    })
  })

  it("returns null for a null contact", () => {
    expect(buildContactPayload(null, colors)).toBeNull()
  })
})

describe("formatDateLabel", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 3, 27, 12, 0, 0)) // 2026-04-27 12:00 local
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("returns 'Today' for a timestamp on today's date", () => {
    const today = new Date(2026, 3, 27, 9, 30, 0).getTime()
    expect(formatDateLabel(today)).toBe("Today")
  })

  it("returns 'Yesterday' for a timestamp 24h before now", () => {
    const yesterday = new Date(2026, 3, 26, 9, 30, 0).getTime()
    expect(formatDateLabel(yesterday)).toBe("Yesterday")
  })

  it("returns 'DD Month' for older timestamps", () => {
    const older = new Date(2026, 1, 3, 9, 30, 0).getTime() // 2026-02-03
    expect(formatDateLabel(older)).toBe("03 February")
  })
})

describe("formatTimeLabel", () => {
  it("zero-pads single-digit hours and minutes", () => {
    const t = new Date(2026, 1, 3, 4, 7, 0).getTime() // 04:07 local
    expect(formatTimeLabel(t)).toBe("04:07")
  })

  it("formats double-digit hours and minutes correctly", () => {
    const t = new Date(2026, 1, 3, 23, 59, 0).getTime()
    expect(formatTimeLabel(t)).toBe("23:59")
  })
})

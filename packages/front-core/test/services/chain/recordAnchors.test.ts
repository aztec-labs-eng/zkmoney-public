import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { Address, Hash } from "viem"
import { InMemoryStorageAdapter } from "../../__test-helpers__/InMemoryStorageAdapter"
import { resetSingleton } from "../../__test-helpers__/resetSingleton"
import { setActiveNetworkId, getActiveNetworkId } from "../../../src/core/activeNetworkId"
import type {
  ReorgTxReceiptLike,
  ReorgNodeLike,
} from "../../../src/core/services/chain/receiptTypes"
import { AccountStorage } from "../../../src/core/storages/AccountStorage"
import { TransactionStorage } from "../../../src/core/storages/TransactionStorage"
import { WithdrawalStorage } from "../../../src/core/services/bridge/WithdrawalStorage"
import type { WithdrawalRecord } from "../../../src/core/services/bridge/types"
import {
  SIPADepositStore,
  type SIPADepositRecord,
} from "../../../src/core/services/deposits/SIPADepositStore"
import type { TokenInTxService } from "../../../src/types"
import { TxStatus } from "@aztec/stdlib/tx"

const NETWORK_ID = "0x" + "ab".repeat(20)
const TX_HASH = "0x" + "11".repeat(32)
const BLOCK_HASH = "0x" + "22".repeat(32)

const token: TokenInTxService = {
  name: "ETH",
  decimals: 18,
  logo: "",
  price: 0,
  symbol: "ETH",
  address: "0xtoken",
  amount: 1,
  hasUnknownAmount: false,
}

afterEach(() => {
  setActiveNetworkId(undefined)
})

describe("receipt shape", () => {
  it("ReorgTxReceiptLike / ReorgNodeLike are structural", async () => {
    const receipt: ReorgTxReceiptLike = {
      status: TxStatus.PROPOSED,
      blockNumber: 7,
      blockHash: BLOCK_HASH,
    }
    const node: ReorgNodeLike = { getTxReceipt: async () => receipt }
    await expect(node.getTxReceipt(TX_HASH)).resolves.toEqual(receipt)
  })
})

describe("Transaction row anchors + networkId", () => {
  let transactions: TransactionStorage

  beforeEach(() => {
    resetSingleton(AccountStorage as unknown as { instance: AccountStorage | null })
    resetSingleton(TransactionStorage as unknown as { instance: TransactionStorage | null })
    const adapter = new InMemoryStorageAdapter()
    AccountStorage.get(adapter)
    transactions = TransactionStorage.get(adapter)
  })

  it("stamps networkId from the active network at creation; anchors start absent", async () => {
    setActiveNetworkId(NETWORK_ID)
    await transactions.addTokenTransaction("send", { ...token }, "pending", TX_HASH)
    const [row] = await transactions.getTransactions()
    expect(row.networkId).toBe(NETWORK_ID)
    expect(row.blockNumber).toBeUndefined()
    expect(row.blockHash).toBeUndefined()
    expect(row.tier).toBeUndefined()
    expect(row.reorgEpoch).toBeUndefined()
  })

  it("leaves networkId unset when no active network is published", async () => {
    expect(getActiveNetworkId()).toBeUndefined()
    await transactions.addTokenTransaction("send", { ...token }, "pending", TX_HASH)
    const [row] = await transactions.getTransactions()
    expect(row.networkId).toBeUndefined()
  })

  it("anchor fields round-trip once inclusion is observed", async () => {
    setActiveNetworkId(NETWORK_ID)
    await transactions.addTokenTransaction("send", { ...token }, "pending", TX_HASH)
    await transactions.updateTransaction(
      (tx) => tx.txHash === TX_HASH,
      (tx) => {
        tx.blockNumber = 42
        tx.blockHash = BLOCK_HASH
        tx.tier = "proposed"
        tx.reorgEpoch = 0
      },
    )
    const [row] = await transactions.getTransactions()
    expect(row.blockNumber).toBe(42)
    expect(row.blockHash).toBe(BLOCK_HASH)
    expect(row.tier).toBe("proposed")
    expect(row.reorgEpoch).toBe(0)
  })
})

describe("WithdrawalRecord anchors + networkId", () => {
  function makeRecord(overrides: Partial<WithdrawalRecord> = {}): WithdrawalRecord {
    return {
      localId: "local-1",
      recipient: "0x1234567890abcdef1234567890abcdef12345678" as Address,
      recipientProvenance: "saved-recipient",
      amount: "1.0",
      tokenSymbol: "DAI",
      phase: "submitting",
      startTime: 1_700_000_000_000,
      ...overrides,
    }
  }

  beforeEach(() => {
    resetSingleton(WithdrawalStorage as unknown as { instance: WithdrawalStorage | null })
  })

  it("create stamps networkId from the active network when absent", async () => {
    setActiveNetworkId(NETWORK_ID)
    const store = WithdrawalStorage.get(new InMemoryStorageAdapter())
    await store.load()
    const stored = await store.create(makeRecord())
    expect(stored.networkId).toBe(NETWORK_ID)
  })

  it("create keeps an explicit networkId", async () => {
    setActiveNetworkId(NETWORK_ID)
    const store = WithdrawalStorage.get(new InMemoryStorageAdapter())
    await store.load()
    const stored = await store.create(makeRecord({ networkId: "0xother" }))
    expect(stored.networkId).toBe("0xother")
  })

  it("blockHash + reorgEpoch round-trip via patch", async () => {
    const store = WithdrawalStorage.get(new InMemoryStorageAdapter())
    await store.load()
    await store.create(makeRecord())
    const patched = await store.patch("local-1", {
      phase: "l2_mined",
      l2TxHash: TX_HASH as Hash,
      blockNumber: 42,
      blockHash: BLOCK_HASH,
      reorgEpoch: 1,
    })
    expect(patched.blockHash).toBe(BLOCK_HASH)
    expect(patched.reorgEpoch).toBe(1)
  })
})

describe("SIPADepositRecord networkId", () => {
  const SIPA_ADDR = "0xAbCdEf0123456789abcdef0123456789abcdef01" as Address

  function fallback(): Omit<SIPADepositRecord, "sipaAddress" | "phase"> {
    return {
      recipientL2Address: "0x" + "33".repeat(32),
      messageSecret: "0x" + "11".repeat(32),
      recipientHash: "0x" + "22".repeat(32),
      recoveryAddress: "0xfd9df8ea9d7350063da52e60e7e1b6d78449786a",
      l1ChainId: 11155111,
      amount: "12.5",
      tokenSymbol: "DAI",
      startTime: 1000,
    }
  }

  beforeEach(() => {
    resetSingleton(SIPADepositStore as unknown as { instance: SIPADepositStore | null })
  })

  it("stamps networkId on first insert and preserves it across patches", async () => {
    setActiveNetworkId(NETWORK_ID)
    const store = SIPADepositStore.get(new InMemoryStorageAdapter())
    await store.upsert(SIPA_ADDR, { phase: "broadcast" }, fallback())
    expect(store.get(SIPA_ADDR)?.networkId).toBe(NETWORK_ID)

    setActiveNetworkId(undefined)
    await store.upsert(SIPA_ADDR, { phase: "sweeping" })
    expect(store.get(SIPA_ADDR)?.networkId).toBe(NETWORK_ID)
  })
})

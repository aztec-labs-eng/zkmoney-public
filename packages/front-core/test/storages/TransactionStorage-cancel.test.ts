import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { AUTH_TYPE, QueueStatus } from "@obsidion/sdk"
import {
  AccountStorage,
  NetworkStorage,
  TRANSACTIONS_STORAGE_KEY,
  TransactionStorage,
  globalEventEmitter,
} from "../../src/core"
import { TransactionTracker } from "../../src/core/services/transactions/TransactionTracker"
import type {
  Transaction,
  TokenInTxService,
  TokenTransaction,
  ContractCallTransaction,
} from "../../src/types"
import { InMemoryStorageAdapter } from "../__test-helpers__/InMemoryStorageAdapter"
import { createAztecNodeClient } from "@aztec/aztec.js/node"

// We import the module so we can spy on `createAztecNodeClient` if it ever
// gets called — a guard for the lazy-poll-removal regression test.
vi.mock("@aztec/aztec.js/node", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aztec/aztec.js/node")>()
  return {
    ...actual,
    createAztecNodeClient: vi.fn(),
  }
})

vi.mock("@aztec/stdlib/tx", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aztec/stdlib/tx")>()
  return {
    ...actual,
    TxHash: {
      ...actual.TxHash,
      fromString: vi.fn((str: string) => ({ toString: () => str })),
    },
  }
})

const ADDR = "0x" + "a".repeat(64)

const seedAccount = {
  name: "Alice",
  completeAddress: ADDR,
  signKeyConfig: {
    type: AUTH_TYPE.WEB_AUTHN,
    webauthnData: { credentialId: "cred-1", pubkey: "pubkey-1" },
  },
}
void seedAccount

const resetSingletons = () => {
  ;(AccountStorage as unknown as { instance: AccountStorage | null }).instance = null
  ;(TransactionStorage as unknown as { instance: TransactionStorage | null }).instance = null
  ;(NetworkStorage as unknown as { instance: NetworkStorage | null }).instance = null
}

const setup = () => {
  resetSingletons()
  const adapter = new InMemoryStorageAdapter()
  AccountStorage.get(adapter)
  const transactions = TransactionStorage.get(adapter)
  return { adapter, transactions }
}

const sampleToken = (overrides: Partial<TokenInTxService> = {}): TokenInTxService => ({
  name: "ETH",
  decimals: 18,
  logo: "https://example.com/eth.png",
  price: 1000,
  symbol: "ETH",
  address: "0xtoken",
  amount: 1,
  hasUnknownAmount: false,
  ...overrides,
})

const stubTracker = (queue: any[] = []) => {
  ;(TransactionTracker as unknown as { instance: any }).instance = null
  const tracker = TransactionTracker.getInstance()
  vi.spyOn(tracker, "getQueue").mockReturnValue(queue)
  return tracker
}

describe("TransactionStorage — cancel + kind", () => {
  beforeEach(() => {
    resetSingletons()
    stubTracker()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe("updateTransactionCompletion (widened terminal statuses)", () => {
    it("CANCELLED happy path: persists CANCELLED without collapsing to FAILED", async () => {
      const { transactions } = setup()
      await transactions.addTokenTransaction(
        "send",
        sampleToken(),
        "pending",
        "0xtxhash",
        "0xrecipient",
        "queue-cancel-1",
      )

      await transactions.updateTransactionCompletion("queue-cancel-1", QueueStatus.CANCELLED, 1234)

      const txs = await transactions.getTransactions()
      expect(txs).toHaveLength(1)
      expect(txs[0].detailedStatus).toBe(QueueStatus.CANCELLED)
      // Legacy tri-state collapse: CANCELLED -> "failed" (no-op outcome).
      expect(txs[0].status).toBe("failed")
      expect(txs[0].endTime).toBe(1234)
      expect(txs[0].queueId).toBeUndefined()
    })

    it("monotonicity: a later SUCCESS tick after CANCELLED is a no-op", async () => {
      const { transactions } = setup()
      await transactions.addTokenTransaction(
        "send",
        sampleToken(),
        "pending",
        "0xtxhash",
        "0xrecipient",
        "queue-mono-1",
      )

      await transactions.updateTransactionCompletion("queue-mono-1", QueueStatus.CANCELLED, 100)

      // Stale polling-loop tick races in with a SUCCESS observation.
      await transactions.updateTransactionCompletion("queue-mono-1", QueueStatus.SUCCESS, 200)

      const txs = await transactions.getTransactions()
      // The CANCELLED write wins — the later SUCCESS does nothing.
      expect(txs[0].detailedStatus).toBe(QueueStatus.CANCELLED)
      expect(txs[0].status).toBe("failed")
      expect(txs[0].endTime).toBe(100)
    })
  })

  describe("kind field round-trip", () => {
    it("legacy records (no kind) read back as kind: 'send'", async () => {
      const { transactions, adapter } = setup()
      const legacyRow = {
        action: "send",
        token: sampleToken(),
        timestamp: 3000,
        status: "success" as const,
        txHash: "0xlegacy",
        // no `kind` field — legacy record
      }
      await adapter.setItem(TRANSACTIONS_STORAGE_KEY, JSON.stringify([legacyRow]))

      const txs = await transactions.getTransactions()
      expect(txs).toHaveLength(1)
      expect(txs[0].kind).toBe("send")
    })

    it("BaseTransaction round-trips through storage with the new kind field", async () => {
      const { transactions, adapter } = setup()
      const original: TokenTransaction = {
        action: "send",
        token: sampleToken(),
        timestamp: 4000,
        status: "pending",
        txHash: "0xoriginal",
        kind: "send",
      }
      await adapter.setItem(TRANSACTIONS_STORAGE_KEY, JSON.stringify([original]))

      const txs = await transactions.getTransactions()
      // Persisted shape comes back identical (kind preserved verbatim).
      expect(txs[0]).toMatchObject({
        action: "send",
        timestamp: 4000,
        status: "pending",
        txHash: "0xoriginal",
        kind: "send",
      })
    })
  })

  describe("lazy-poll removal regression", () => {
    // Seed a PENDING contract-call record + stub `node.getTxReceipt` that, if
    // invoked, would return mined-success. After calling
    // `TransactionStorage.get().getTransactions()` we assert:
    //
    //   a) status is still PENDING (raw read, not patched),
    //   b) `node.getTxReceipt` was NOT called,
    //   c) no `transactionsUpdated` event fired.
    //
    // This guards against re-introducing the old lazy poll inside
    // `getTransactions()` — the unified 1Hz `TxLifecycleService` loop is the
    // sole authority for terminal-status writes from the polling path.

    const networkConfig = {
      name: "test",
      displayName: "Test",
      description: "Test",
      id: "test",
      type: "testnet" as any,
      nodeUrl: "http://node",
      l1RpcUrl: "http://rpc",
      current: true,
    }

    beforeEach(() => {
      vi.spyOn(NetworkStorage, "get").mockReturnValue({
        getNetwork: vi.fn().mockResolvedValue(networkConfig),
      } as any)
    })

    it("does not call node.getTxReceipt or fire transactionsUpdated", async () => {
      const { transactions, adapter } = setup()
      await adapter.setItem(
        TRANSACTIONS_STORAGE_KEY,
        JSON.stringify([
          {
            action: "contract_call",
            status: "pending",
            txHash: "0xpending",
          } as ContractCallTransaction,
        ]),
      )

      const getTxReceipt = vi.fn().mockResolvedValue({ status: "checkpointed" })
      vi.mocked(createAztecNodeClient).mockReturnValue({ getTxReceipt } as any)

      const eventHandler = vi.fn()
      globalEventEmitter.onTransactionsUpdated(eventHandler)

      try {
        const txs = await transactions.getTransactions()

        // (a) Status still PENDING — raw read, not patched.
        expect(txs[0].status).toBe("pending")
        // (b) Node RPC NOT invoked.
        expect(createAztecNodeClient).not.toHaveBeenCalled()
        expect(getTxReceipt).not.toHaveBeenCalled()
        // (c) No event fired (event would force a re-render loop).
        expect(eventHandler).not.toHaveBeenCalled()
      } finally {
        globalEventEmitter.offTransactionsUpdated(eventHandler)
      }
    })
  })
})

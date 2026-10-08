import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { AUTH_TYPE, QueueStatus } from "@obsidion/sdk"
import {
  ACCOUNT_STORAGE_KEY,
  AccountStorage,
  NetworkStorage,
  TRANSACTIONS_STORAGE_KEY,
  TransactionStorage,
  globalEventEmitter,
} from "../../src/core"
import { TransactionTracker } from "../../src/core/services/transactions/TransactionTracker"
import { TransferEventScanner } from "../../src/core/services/transactions/TransferEventScanner"
import { PaylinkActionEnum } from "@obsidion/core/constants"
import type { Transaction, TokenInTxService, ContractCallTransaction } from "../../src/types"
import { InMemoryStorageAdapter } from "../__test-helpers__/InMemoryStorageAdapter"
import { createAztecNodeClient } from "@aztec/aztec.js/node"
import { TxStatus } from "@aztec/stdlib/tx"

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

const resetSingletons = () => {
  ;(AccountStorage as unknown as { instance: AccountStorage | null }).instance = null
  ;(TransactionStorage as unknown as { instance: TransactionStorage | null }).instance = null
  ;(NetworkStorage as unknown as { instance: NetworkStorage | null }).instance = null
}

const setup = () => {
  resetSingletons()
  const adapter = new InMemoryStorageAdapter()
  const accounts = AccountStorage.get(adapter)
  const transactions = TransactionStorage.get(adapter)
  return { adapter, accounts, transactions }
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

describe("TransactionStorage", () => {
  beforeEach(() => {
    resetSingletons()
    stubTracker()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe("happy path writes", () => {
    it("addTokenTransaction persists under the new key (not on AccountState)", async () => {
      const { transactions, adapter } = setup()
      const token = sampleToken()

      await transactions.addTokenTransaction(
        "send",
        token,
        "pending",
        "0xtxhash",
        "0xrecipient",
        undefined,
      )

      const raw = await adapter.getItem(TRANSACTIONS_STORAGE_KEY)
      expect(raw).not.toBeNull()
      const persisted = JSON.parse(raw!) as Transaction[]
      expect(persisted).toHaveLength(1)
      expect(persisted[0]).toMatchObject({
        action: "send",
        token: { symbol: "ETH", address: "0xtoken" },
        status: "pending",
        txHash: "0xtxhash",
        to: "0xrecipient",
      })

      // Account blob is untouched
      expect(await adapter.getItem(ACCOUNT_STORAGE_KEY)).toBeNull()
    })

    it("addTokenTransaction accepts a 'receive' action", async () => {
      const { transactions } = setup()

      await transactions.addTokenTransaction(
        "receive",
        sampleToken(),
        "success",
        "0xrecvhash",
        undefined,
        undefined,
      )

      const txs = await transactions.getTransactions()
      expect(txs).toHaveLength(1)
      expect(txs[0]).toMatchObject({
        action: "receive",
        status: "success",
        txHash: "0xrecvhash",
      })
    })

    it("addFaucetTransaction persists with description", async () => {
      const { transactions } = setup()

      await transactions.addFaucetTransaction(
        sampleToken({ symbol: "WETH" }),
        "success",
        "0xtxhash",
        undefined,
      )

      const txs = await transactions.getTransactions()
      expect(txs).toHaveLength(1)
      expect(txs[0]).toMatchObject({
        action: "faucet",
        status: "success",
        description: "Received tokens from faucet",
      })
    })

    it("createPaylinkTransaction pulls queueItem details from the tracker", async () => {
      const { transactions } = setup()
      stubTracker([
        {
          id: "queue123",
          status: QueueStatus.PENDING,
          progress: 12,
          startTime: 111,
          estimatedDuration: 30000,
          description: "Sending payment via email",
        },
      ])

      await transactions.createPaylinkTransaction(
        "queue123",
        "0xtxhash",
        "Pay To Email" as any,
        "email",
        sampleToken(),
        "recipient@example.com",
        "secret",
        "0xobsidion",
        "0xpartial",
        "0xtoken",
        "https://paylink.example",
      )

      const txs = await transactions.getTransactions()
      expect(txs[0]).toMatchObject({
        emailPaymentAction: "Pay To Email",
        flavor: "email",
        payToEmailSecret: "secret",
        obsidionAccountAddress: "0xobsidion",
        partialAddress: "0xpartial",
        tokenAddress: "0xtoken",
        paylink: "https://paylink.example",
      })
    })

    it("createPaylinkTransaction accepts flavor='zk'", async () => {
      const { transactions } = setup()
      stubTracker([
        {
          id: "queue-zk",
          status: QueueStatus.PENDING,
          progress: 0,
          startTime: 222,
          estimatedDuration: 30000,
          description: "ZK claim",
        },
      ])

      await transactions.createPaylinkTransaction(
        "queue-zk",
        "0xtxhash",
        "Claim With Email" as any,
        "zk",
        sampleToken(),
      )

      const txs = await transactions.getTransactions()
      expect(txs[0]).toMatchObject({
        emailPaymentAction: "Claim With Email",
        flavor: "zk",
      })
    })
  })

  describe("queue sync", () => {
    it("updateActiveTransactionsFromQueue updates an existing entry in place", async () => {
      const { transactions } = setup()
      await transactions.addTokenTransaction(
        "send",
        sampleToken(),
        "pending",
        undefined,
        undefined,
        "queue123",
      )

      await transactions.updateActiveTransactionsFromQueue([
        {
          id: "queue123",
          status: QueueStatus.PROVING_AND_SENDING,
          progress: 75,
          txHash: "0xnewhash",
          error: undefined,
          endTime: undefined,
          description: "Processing",
          startTime: Date.now(),
        },
      ])

      const txs = await transactions.getTransactions()
      expect(txs[0]).toMatchObject({
        progress: 75,
        txHash: "0xnewhash",
        detailedStatus: "proving and sending",
        status: "pending",
      })
    })

    it("does nothing when the queue is empty", async () => {
      const { transactions } = setup()
      await transactions.addTokenTransaction(
        "send",
        sampleToken(),
        "pending",
        undefined,
        undefined,
        "queue123",
      )

      await expect(transactions.updateActiveTransactionsFromQueue([])).resolves.not.toThrow()
    })
  })

  describe("updateTransactionCompletion", () => {
    it("strips queueId and keeps the creation timestamp", async () => {
      const { transactions } = setup()
      await transactions.addTokenTransaction(
        "send",
        sampleToken(),
        "pending",
        undefined,
        undefined,
        "queue123",
      )
      const [{ timestamp: createdAt }] = await transactions.getTransactions()

      await transactions.updateTransactionCompletion("queue123", QueueStatus.SUCCESS, 999)

      const txs = await transactions.getTransactions()
      expect(txs[0]).toMatchObject({
        status: "success",
        endTime: 999,
        timestamp: createdAt,
      })
      expect(txs[0].queueId).toBeUndefined()
    })
  })

  describe("updateTransaction (generic update)", () => {
    it("returns true and persists when predicate matches", async () => {
      const { transactions } = setup()
      await transactions.addTokenTransaction(
        "send",
        sampleToken(),
        "pending",
        "0xfirst",
        undefined,
        undefined,
      )

      const ok = await transactions.updateTransaction(
        (tx) => tx.txHash === "0xfirst",
        (tx) => {
          tx.status = "success"
        },
      )

      expect(ok).toBe(true)
      const txs = await transactions.getTransactions()
      expect(txs[0].status).toBe("success")
    })

    it("returns false when no predicate matches", async () => {
      const { transactions } = setup()
      const ok = await transactions.updateTransaction(
        () => false,
        () => {},
      )
      expect(ok).toBe(false)
    })
  })

  describe("claim memo from the payout Transfer", () => {
    it("lands the scanned payout's memo on a completed claim row, and never overwrites it", async () => {
      const { transactions } = setup()
      const claimHash = "0x" + "c1".repeat(32)
      await transactions.addPreSubmitPaylinkTransaction("claim-q", "op-1", {
        action: PaylinkActionEnum.CLAIM,
        flavor: "direct",
        token: sampleToken(),
      })
      await transactions.patchTxHashForQueue("claim-q", claimHash)
      // Completion clears the queueId before any payout is scanned.
      await transactions.updateTransactionCompletion("claim-q", QueueStatus.SUCCESS)

      const payout = (memo: string, blockNumber: number) => ({
        txHash: claimHash,
        from: "0x" + "e5".repeat(32),
        to: ADDR,
        amount: "1000000",
        blockNumber,
        memo,
      })
      let events = [payout("for the tickets", 5)]
      const scanner = new TransferEventScanner({
        source: {
          headBlock: async () => 10,
          listIncoming: async () => events,
          blockTimestampMs: async (b) => b * 1000,
        },
        storage: new InMemoryStorageAdapter(),
        transactionStore: transactions,
        tags: { resolveL2: async () => null },
        contacts: { findByL2Address: async () => null },
        token: { address: "0xtoken", symbol: "DAI", decimals: 6 },
      })
      const ctx = { accountAddress: ADDR, accountTag: "me", networkId: "net" }
      await scanner.start(ctx)
      events = [payout("other", 6)]
      await scanner.tickNow()
      scanner.stop()

      const rows = await transactions.getTransactions()
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ action: PaylinkActionEnum.CLAIM, memo: "for the tickets" })
    })
  })

  describe("clearTransactions", () => {
    it("wipes the persisted list", async () => {
      const { transactions } = setup()
      await transactions.addTokenTransaction(
        "send",
        sampleToken(),
        "pending",
        undefined,
        undefined,
        undefined,
      )

      await transactions.clearTransactions()

      expect(await transactions.getTransactions()).toEqual([])
    })
  })

  describe("checkTxStatusFromNode (deprecated opt-in helper)", () => {
    // `getTransactions()` no longer triggers this code path — it's
    // a raw storage read. These cases now invoke `checkTxStatusFromNode`
    // directly to keep coverage of the receipt-reconciliation logic until
    // the helper is removed in Phase N+1.

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
      // Stub NetworkStorage.get() to return an object whose getNetwork resolves
      // to our test network config — bypasses the singleton-init requirement.
      vi.spyOn(NetworkStorage, "get").mockReturnValue({
        getNetwork: vi.fn().mockResolvedValue(networkConfig),
      } as any)
    })

    it("upgrades a pending contract-call tx to success on CHECKPOINTED", async () => {
      const { transactions, adapter } = setup()
      adapter.setItem(
        TRANSACTIONS_STORAGE_KEY,
        JSON.stringify([
          {
            action: "contract_call",
            status: "pending",
            txHash: "0xtxhash",
          } as ContractCallTransaction,
        ]),
      )

      const fakeNode = {
        getTxReceipt: vi.fn().mockResolvedValue({ status: TxStatus.CHECKPOINTED }),
      }
      vi.mocked(createAztecNodeClient).mockReturnValue(fakeNode as any)

      const seed = await transactions.getTransactions()
      const txs = await transactions.checkTxStatusFromNode(seed)
      expect(txs[0].status).toBe("success")
      expect(txs[0].progress).toBe(100)
    })

    it("marks contract-call tx as failed on DROPPED", async () => {
      const { transactions, adapter } = setup()
      adapter.setItem(
        TRANSACTIONS_STORAGE_KEY,
        JSON.stringify([
          {
            action: "contract_call",
            status: "pending",
            txHash: "0xtxhash",
          } as ContractCallTransaction,
        ]),
      )

      const fakeNode = { getTxReceipt: vi.fn().mockResolvedValue({ status: TxStatus.DROPPED }) }
      vi.mocked(createAztecNodeClient).mockReturnValue(fakeNode as any)

      const seed = await transactions.getTransactions()
      const txs = await transactions.checkTxStatusFromNode(seed)
      expect(txs[0].status).toBe("failed")
    })

    it("swallows per-tx receipt errors", async () => {
      const { transactions, adapter } = setup()
      adapter.setItem(
        TRANSACTIONS_STORAGE_KEY,
        JSON.stringify([
          {
            action: "contract_call",
            status: "pending",
            txHash: "0xtxhash",
          } as ContractCallTransaction,
        ]),
      )

      const fakeNode = {
        getTxReceipt: vi.fn().mockRejectedValue(new Error("Transaction not found")),
      }
      vi.mocked(createAztecNodeClient).mockReturnValue(fakeNode as any)

      const seed = await transactions.getTransactions()
      await expect(transactions.checkTxStatusFromNode(seed)).resolves.not.toThrow()
    })
  })

  describe("legacy migration", () => {
    it("lifts AccountState.transactions[] into the new key on first load", async () => {
      resetSingletons()
      const adapter = new InMemoryStorageAdapter()
      const legacyTxs = [
        { action: "send", status: "success", txHash: "0xfirst" } as any,
        { action: "faucet", status: "success", txHash: "0xsecond" } as any,
      ]
      await adapter.setItem(
        ACCOUNT_STORAGE_KEY,
        JSON.stringify({ ...seedAccount, transactions: legacyTxs }),
      )

      AccountStorage.get(adapter)
      const transactions = TransactionStorage.get(adapter)
      const txs = await transactions.getTransactions()

      // Projection adds `kind: "send"` to legacy rows lacking the field; the
      // legacy migration path runs through the same projection helper as the
      // parsed-rows path so the shape returned on first load matches every
      // subsequent load.
      expect(txs).toEqual(legacyTxs.map((tx) => ({ ...tx, kind: "send" })))
      const persistedAccount = JSON.parse((await adapter.getItem(ACCOUNT_STORAGE_KEY))!)
      expect(persistedAccount.transactions).toBeUndefined()
    })

    it("ignores legacy data when the new key already has data", async () => {
      resetSingletons()
      const adapter = new InMemoryStorageAdapter()
      const newTx = [{ action: "send", status: "success", txHash: "0xnew" } as any]
      const legacyTx = [{ action: "send", status: "success", txHash: "0xlegacy" } as any]

      await adapter.setItem(TRANSACTIONS_STORAGE_KEY, JSON.stringify(newTx))
      await adapter.setItem(
        ACCOUNT_STORAGE_KEY,
        JSON.stringify({ ...seedAccount, transactions: legacyTx }),
      )

      AccountStorage.get(adapter)
      const transactions = TransactionStorage.get(adapter)
      const txs = await transactions.getTransactions()

      // Back-compat: legacy records (no `kind` field) default to `kind: 'send'`
      // on read, so the read-back shape is a superset of the seeded one.
      expect(txs).toEqual(newTx.map((tx) => ({ ...tx, kind: "send" })))
    })

    // Regression: if the new-key write rejects after
    // the legacy rows have been read, those rows must NOT be lost. The fix
    // splits the migration into read → new-key write → strip, so a failed
    // new-key write leaves the account blob untouched. A retry on the next
    // load reads the legacy rows again and replays the migration.
    it("preserves legacy rows when the new-key write fails, and retries on next load", async () => {
      resetSingletons()
      const adapter = new InMemoryStorageAdapter()
      const legacyTxs = [{ action: "send", status: "success", txHash: "0xfirst" } as any]
      await adapter.setItem(
        ACCOUNT_STORAGE_KEY,
        JSON.stringify({ ...seedAccount, transactions: legacyTxs }),
      )

      // Spy on adapter.setItem and reject only the FIRST write to the new
      // transaction key. All other setItem calls (including the strip
      // restore on retry) pass through to the real adapter.
      const realSetItem = adapter.setItem.bind(adapter)
      let rejectionsRemaining = 1
      const setItemSpy = vi
        .spyOn(adapter, "setItem")
        .mockImplementation(async (key: string, value: string) => {
          if (key === TRANSACTIONS_STORAGE_KEY && rejectionsRemaining > 0) {
            rejectionsRemaining -= 1
            throw new Error("simulated transient storage failure")
          }
          await realSetItem(key, value)
        })

      AccountStorage.get(adapter)
      const transactions = TransactionStorage.get(adapter)

      // First load: new-key write rejects → rejection bubbles up.
      await expect(transactions.getTransactions()).rejects.toThrow(
        "simulated transient storage failure",
      )

      // Account blob still holds legacy rows because consume is read-only
      // and strip never ran.
      const accountAfterFail = JSON.parse((await adapter.getItem(ACCOUNT_STORAGE_KEY))!)
      expect(accountAfterFail.transactions).toEqual(legacyTxs)
      // New key was never written.
      expect(await adapter.getItem(TRANSACTIONS_STORAGE_KEY)).toBeNull()

      // Second load: setItem now succeeds. Migration replays from the
      // still-readable account blob. Legacy rows surface in the new key
      // and the account blob is stripped. The returned shape is projected
      // (same helper as the parsed-rows path).
      const txs = await transactions.getTransactions()
      expect(txs).toEqual(legacyTxs.map((tx) => ({ ...tx, kind: "send" })))
      const accountAfterRetry = JSON.parse((await adapter.getItem(ACCOUNT_STORAGE_KEY))!)
      expect(accountAfterRetry.transactions).toBeUndefined()
      setItemSpy.mockRestore()
    })

    it("succeeds and survives a strip failure (new-key write already happened)", async () => {
      resetSingletons()
      const adapter = new InMemoryStorageAdapter()
      const legacyTxs = [{ action: "send", status: "success", txHash: "0xfirst" } as any]
      await adapter.setItem(
        ACCOUNT_STORAGE_KEY,
        JSON.stringify({ ...seedAccount, transactions: legacyTxs }),
      )

      const realSetItem = adapter.setItem.bind(adapter)
      const setItemSpy = vi
        .spyOn(adapter, "setItem")
        .mockImplementation(async (key: string, value: string) => {
          // Fail the strip write specifically: after the new-key write,
          // the next ACCOUNT_STORAGE_KEY write is the strip.
          if (key === ACCOUNT_STORAGE_KEY) {
            throw new Error("simulated strip failure")
          }
          await realSetItem(key, value)
        })

      AccountStorage.get(adapter)
      const transactions = TransactionStorage.get(adapter)
      // Migration must succeed (strip failure is non-blocking). Returned
      // shape is projected, matching the parsed-rows path.
      const txs = await transactions.getTransactions()
      expect(txs).toEqual(legacyTxs.map((tx) => ({ ...tx, kind: "send" })))
      // New key has the data.
      const persisted = await adapter.getItem(TRANSACTIONS_STORAGE_KEY)
      expect(persisted).not.toBeNull()
      // Account blob still has the field — that's fine; next load reads
      // from the now-non-null new key and short-circuits the migration.
      const accountBlob = JSON.parse((await adapter.getItem(ACCOUNT_STORAGE_KEY))!)
      expect(accountBlob.transactions).toEqual(legacyTxs)
      setItemSpy.mockRestore()
    })
  })

  describe("paylink flavor read-time projection", () => {
    it("projects flavor='email' onto a legacy paylink row whose `to` looks like an email", async () => {
      resetSingletons()
      const adapter = new InMemoryStorageAdapter()
      // Legacy paylink row pre-dates the `flavor` discriminator. Persisted
      // shape carries `emailPaymentAction` (the legacy field name) and an
      // email-shaped recipient in `to`.
      const legacyRow = {
        action: "Pay To Email",
        emailPaymentAction: "Pay To Email",
        status: "pending",
        txHash: "0xemail",
        timestamp: 1,
        to: "alice@example.com",
      } as any
      await adapter.setItem(TRANSACTIONS_STORAGE_KEY, JSON.stringify([legacyRow]))

      AccountStorage.get(adapter)
      const transactions = TransactionStorage.get(adapter)
      const txs = await transactions.getTransactions()

      expect(txs).toHaveLength(1)
      expect(txs[0]).toMatchObject({
        emailPaymentAction: "Pay To Email",
        to: "alice@example.com",
        flavor: "email",
        kind: "send",
      })
    })

    it("projects flavor='direct' onto a legacy paylink row with no `to` field", async () => {
      resetSingletons()
      const adapter = new InMemoryStorageAdapter()
      // Legacy direct paylinks persisted no recipient; the heuristic must
      // fall back to "direct" rather than blanket-defaulting to "email".
      const legacyRow = {
        action: "Pay To Email",
        emailPaymentAction: "Pay To Email",
        status: "pending",
        txHash: "0xdirect",
        timestamp: 1,
        payToEmailSecret: "secret",
      } as any
      await adapter.setItem(TRANSACTIONS_STORAGE_KEY, JSON.stringify([legacyRow]))

      AccountStorage.get(adapter)
      const transactions = TransactionStorage.get(adapter)
      const txs = await transactions.getTransactions()

      expect(txs).toHaveLength(1)
      expect(txs[0]).toMatchObject({
        emailPaymentAction: "Pay To Email",
        flavor: "direct",
        kind: "send",
      })
    })

    it("does NOT overwrite an existing flavor on already-flavored rows", async () => {
      resetSingletons()
      const adapter = new InMemoryStorageAdapter()
      // Row written by post-rename code already carries `flavor`; the
      // projection must be a no-op for these rows.
      const flavoredRow = {
        action: "Pay To Email",
        emailPaymentAction: "Pay To Email",
        status: "pending",
        txHash: "0xflavored",
        timestamp: 1,
        flavor: "direct",
        to: "looks-like@anEmail.com",
      } as any
      await adapter.setItem(TRANSACTIONS_STORAGE_KEY, JSON.stringify([flavoredRow]))

      AccountStorage.get(adapter)
      const transactions = TransactionStorage.get(adapter)
      const txs = await transactions.getTransactions()

      expect(txs).toHaveLength(1)
      expect(txs[0]).toMatchObject({ flavor: "direct" })
    })

    it("projects flavor onto paylink rows lifted from legacy AccountState.transactions", async () => {
      resetSingletons()
      const adapter = new InMemoryStorageAdapter()
      // The legacy migration path returns the in-memory legacy array on the
      // very first load (before the new key is read back). That array MUST
      // be projected too, otherwise the first activity-feed render after
      // upgrade would see paylink rows missing the required `flavor` field.
      const legacyEmailRow = {
        action: "Pay To Email",
        emailPaymentAction: "Pay To Email",
        status: "pending",
        txHash: "0xlegacy_email",
        timestamp: 1,
        to: "alice@example.com",
      } as any
      const legacyDirectRow = {
        action: "Pay To Email",
        emailPaymentAction: "Pay To Email",
        status: "pending",
        txHash: "0xlegacy_direct",
        timestamp: 2,
      } as any
      await adapter.setItem(
        ACCOUNT_STORAGE_KEY,
        JSON.stringify({
          ...seedAccount,
          transactions: [legacyEmailRow, legacyDirectRow],
        }),
      )

      AccountStorage.get(adapter)
      const transactions = TransactionStorage.get(adapter)
      const txs = await transactions.getTransactions()

      expect(txs).toHaveLength(2)
      expect(txs[0]).toMatchObject({
        emailPaymentAction: "Pay To Email",
        to: "alice@example.com",
        flavor: "email",
        kind: "send",
      })
      expect(txs[1]).toMatchObject({
        emailPaymentAction: "Pay To Email",
        flavor: "direct",
        kind: "send",
      })
    })
  })

  describe("paylink creator-refund persistence fields", () => {
    // Only the claim-window timestamps (+ the link-absent fallbackSecret) persist
    // as dedicated fields. secret/initHash/paylinkType ride inside `paylink` and
    // are decoded on demand at refund time — never duplicated as row fields.
    it("round-trips fallbackSecret + claim-window timestamps for a created direct paylink", async () => {
      const { transactions } = setup()
      stubTracker([
        {
          id: "queue-direct",
          status: QueueStatus.PENDING,
          progress: 0,
          startTime: 100,
          estimatedDuration: 30000,
          description: "Direct paylink",
        },
      ])

      await transactions.createPaylinkTransaction(
        "queue-direct",
        "0xtxhash",
        "Pay To Email" as any,
        "direct",
        sampleToken(),
        undefined,
        undefined,
        "0xobsidion",
        undefined,
        "0xtoken",
        "https://paylink.example",
        {
          fallbackSecret: "0xtag",
          fromClaimable: 1000,
          untilClaimable: 2000,
          refundableUntil: 2000,
        },
      )

      const txs = await transactions.getTransactions()
      expect(txs[0]).toMatchObject({
        flavor: "direct",
        fallbackSecret: "0xtag",
        fromClaimable: 1000,
        untilClaimable: 2000,
        refundableUntil: 2000,
        paylink: "https://paylink.example",
        txHash: "0xtxhash",
      })
    })

    it("patchPaylinkSynthRow writes the refund fields onto a pre-submit row", async () => {
      const { transactions } = setup()
      await transactions.addPreSubmitPaylinkTransaction("queue-patch", "op-patch", {
        action: "Pay To Email" as any,
        flavor: "direct",
        token: sampleToken(),
        obsidionAccountAddress: "0xobsidion",
        tokenAddress: "0xtoken",
      })

      await transactions.patchPaylinkSynthRow("queue-patch", {
        fallbackSecret: "0xtag",
        paylink: "https://paylink.example",
        fromClaimable: 1000,
        untilClaimable: 2000,
        memo: "for the tickets",
        refundableUntil: 2000,
      })

      const txs = await transactions.getTransactions()
      expect(txs[0]).toMatchObject({
        fallbackSecret: "0xtag",
        paylink: "https://paylink.example",
        fromClaimable: 1000,
        untilClaimable: 2000,
        memo: "for the tickets",
        refundableUntil: 2000,
      })
    })

    it("loads a legacy paylink row (only payToEmailSecret/partialAddress) without the new fields", async () => {
      resetSingletons()
      const adapter = new InMemoryStorageAdapter()
      const legacyRow = {
        action: "Pay To Email",
        emailPaymentAction: "Pay To Email",
        status: "pending",
        txHash: "0xlegacy",
        timestamp: 1,
        flavor: "direct",
        payToEmailSecret: "0xsecret",
        partialAddress: "0xinit",
      } as any
      await adapter.setItem(TRANSACTIONS_STORAGE_KEY, JSON.stringify([legacyRow]))

      AccountStorage.get(adapter)
      const transactions = TransactionStorage.get(adapter)
      const txs = await transactions.getTransactions()

      expect(txs).toHaveLength(1)
      const row = txs[0] as any
      expect(row.payToEmailSecret).toBe("0xsecret")
      expect(row.partialAddress).toBe("0xinit")
      expect(row.fromClaimable).toBeUndefined()
      expect(row.untilClaimable).toBeUndefined()
      expect(row.refundableUntil).toBeUndefined()
    })

    it("scrubs paylink + payToEmailSecret on CANCELLED via updateTransactionCompletion", async () => {
      const { transactions } = setup()
      stubTracker([
        { id: "q-cancel", status: QueueStatus.PENDING, progress: 0, startTime: 1, description: "" },
      ])
      await transactions.createPaylinkTransaction(
        "q-cancel",
        "0xcancel",
        "Pay To Email" as any,
        "direct",
        sampleToken(),
        undefined,
        "0xsecret",
        undefined,
        undefined,
        "0xtoken",
        "https://paylink.example",
        { fallbackSecret: "0xtag" },
      )

      await transactions.updateTransactionCompletion("q-cancel", QueueStatus.CANCELLED)

      const txs = await transactions.getTransactions()
      const row = txs[0] as any
      // Scrubbing `paylink` removes all link-borne secret material (secret/initHash).
      expect(row.paylink).toBeUndefined()
      expect(row.payToEmailSecret).toBeUndefined()
    })

    it("scrubs paylink + payToEmailSecret on CANCELLED via updateByTxHash (polling path)", async () => {
      const { transactions } = setup()
      stubTracker([
        {
          id: "q-cancel2",
          status: QueueStatus.PENDING,
          progress: 0,
          startTime: 1,
          description: "",
        },
      ])
      await transactions.createPaylinkTransaction(
        "q-cancel2",
        "0xcancel2",
        "Pay To Email" as any,
        "direct",
        sampleToken(),
        undefined,
        "0xsecret",
        undefined,
        undefined,
        "0xtoken",
        "https://paylink.example",
        { fallbackSecret: "0xtag" },
      )

      await transactions.updateByTxHash("0xcancel2", QueueStatus.CANCELLED)

      const txs = await transactions.getTransactions()
      const row = txs[0] as any
      expect(row.paylink).toBeUndefined()
      expect(row.payToEmailSecret).toBeUndefined()
    })
  })

  describe("corrupt data handling", () => {
    it("wipes and returns empty when JSON is corrupt", async () => {
      const { transactions, adapter } = setup()
      await adapter.setItem(TRANSACTIONS_STORAGE_KEY, "{not json")

      expect(await transactions.getTransactions()).toEqual([])
      expect(await adapter.getItem(TRANSACTIONS_STORAGE_KEY)).toBeNull()
    })

    it("wipes and returns empty when stored value is not an array", async () => {
      const { transactions, adapter } = setup()
      await adapter.setItem(TRANSACTIONS_STORAGE_KEY, JSON.stringify({ not: "an array" }))

      expect(await transactions.getTransactions()).toEqual([])
      expect(await adapter.getItem(TRANSACTIONS_STORAGE_KEY)).toBeNull()
    })
  })

  describe("event emission", () => {
    it("emits transactionsUpdated on every write", async () => {
      const { transactions } = setup()
      const handler = vi.fn()
      globalEventEmitter.onTransactionsUpdated(handler)

      try {
        await transactions.addTokenTransaction(
          "send",
          sampleToken(),
          "pending",
          undefined,
          undefined,
          undefined,
        )
        await transactions.clearTransactions()

        expect(handler).toHaveBeenCalledTimes(2)
      } finally {
        globalEventEmitter.offTransactionsUpdated(handler)
      }
    })

    it("does not emit accountUpdated on tx writes", async () => {
      const { transactions } = setup()
      const handler = vi.fn()
      globalEventEmitter.onAccountUpdated(handler)

      try {
        await transactions.addTokenTransaction(
          "send",
          sampleToken(),
          "pending",
          undefined,
          undefined,
          undefined,
        )
        expect(handler).not.toHaveBeenCalled()
      } finally {
        globalEventEmitter.offAccountUpdated(handler)
      }
    })
  })

  describe("incoming-transfer write API", () => {
    const sampleIncoming = (
      overrides: Partial<Parameters<TransactionStorage["addIncomingTokenTransaction"]>[0]> = {},
    ) => ({
      txHash: "0xtx-incoming-1",
      from: "alice",
      senderL2Address: "0xaliceL2",
      to: "self",
      token: sampleToken({
        name: "Obsidion DAI",
        symbol: "DAI",
        decimals: 6,
        address: "0xtokencontract",
        amount: 5,
      }),
      timestamp: 1_700_000_000_000,
      memo: "thanks",
      blockNumber: 42,
      requestId: "0x" + "0c".repeat(32),
      amountAtomic: "5000000",
      ...overrides,
    })

    it("inserts a receive row with all fields populated and reports inserted:true", async () => {
      const { transactions, adapter } = setup()

      const result = await transactions.addIncomingTokenTransaction(sampleIncoming())

      expect(result.inserted).toBe(true)
      expect(result.tx.action).toBe("receive")
      expect(result.tx.from).toBe("alice")
      expect(result.tx.to).toBe("self")
      expect(result.tx.senderL2Address).toBe("0xaliceL2")
      expect(result.tx.memo).toBe("thanks")
      expect(result.tx.blockNumber).toBe(42)
      expect(result.tx.requestId).toBe("0x" + "0c".repeat(32))
      expect(result.tx.amountAtomic).toBe("5000000")
      expect(result.tx.txHash).toBe("0xtx-incoming-1")
      expect(result.tx.status).toBe("success")

      const raw = await adapter.getItem(TRANSACTIONS_STORAGE_KEY)
      const persisted = JSON.parse(raw!) as Transaction[]
      expect(persisted).toHaveLength(1)
      expect(persisted[0]).toMatchObject({
        action: "receive",
        txHash: "0xtx-incoming-1",
        senderL2Address: "0xaliceL2",
        requestId: "0x" + "0c".repeat(32),
        amountAtomic: "5000000",
      })
    })

    it("serializes concurrent writes via the writer mutex chain", async () => {
      const { transactions, adapter } = setup()

      await Promise.all([
        transactions.addIncomingTokenTransaction(sampleIncoming({ txHash: "0xa" })),
        transactions.addIncomingTokenTransaction(sampleIncoming({ txHash: "0xb" })),
        transactions.addIncomingTokenTransaction(sampleIncoming({ txHash: "0xc" })),
      ])

      const persisted = JSON.parse(
        (await adapter.getItem(TRANSACTIONS_STORAGE_KEY))!,
      ) as Transaction[]
      expect(persisted).toHaveLength(3)
      expect(persisted.map((t) => t.txHash).sort()).toEqual(["0xa", "0xb", "0xc"])
    })

    it("is idempotent by txHash: re-insert returns existing row with inserted:false", async () => {
      const { transactions, adapter } = setup()

      const first = await transactions.addIncomingTokenTransaction(sampleIncoming())
      expect(first.inserted).toBe(true)

      const second = await transactions.addIncomingTokenTransaction(
        sampleIncoming({
          from: "mallory",
          senderL2Address: "0xmalloryL2",
          memo: "spoofed",
        }),
      )

      expect(second.inserted).toBe(false)
      expect(second.tx.from).toBe("alice")
      expect(second.tx.senderL2Address).toBe("0xaliceL2")
      expect(second.tx.memo).toBe("thanks")

      const persisted = JSON.parse(
        (await adapter.getItem(TRANSACTIONS_STORAGE_KEY))!,
      ) as Transaction[]
      expect(persisted).toHaveLength(1)
    })

    it("two parallel calls with the same txHash produce exactly one row", async () => {
      const { transactions, adapter } = setup()

      const [a, b] = await Promise.all([
        transactions.addIncomingTokenTransaction(sampleIncoming({ txHash: "0xrace" })),
        transactions.addIncomingTokenTransaction(sampleIncoming({ txHash: "0xrace" })),
      ])

      const persisted = JSON.parse(
        (await adapter.getItem(TRANSACTIONS_STORAGE_KEY))!,
      ) as Transaction[]
      expect(persisted.filter((t) => t.txHash === "0xrace")).toHaveLength(1)

      const insertedFlags = [a.inserted, b.inserted].sort()
      expect(insertedFlags).toEqual([false, true])
    })

    it("emits incomingTransfer exactly once on insert, not on duplicate", async () => {
      const { transactions } = setup()
      const listener = vi.fn()
      globalEventEmitter.onIncomingTransfer(listener)

      try {
        await transactions.addIncomingTokenTransaction(sampleIncoming())
        expect(listener).toHaveBeenCalledTimes(1)
        expect(listener.mock.calls[0][0].txHash).toBe("0xtx-incoming-1")

        await transactions.addIncomingTokenTransaction(sampleIncoming())
        expect(listener).toHaveBeenCalledTimes(1)
      } finally {
        globalEventEmitter.offIncomingTransfer(listener)
      }
    })

    it("listener throw inside emit does not poison the chain or fail the write", async () => {
      const { transactions, adapter } = setup()
      const throwingListener = vi.fn(() => {
        throw new Error("listener boom")
      })
      globalEventEmitter.onIncomingTransfer(throwingListener)

      try {
        const first = await transactions.addIncomingTokenTransaction(sampleIncoming())
        expect(first.inserted).toBe(true)
        expect(throwingListener).toHaveBeenCalledTimes(1)

        const second = await transactions.addIncomingTokenTransaction(
          sampleIncoming({ txHash: "0xanother" }),
        )
        expect(second.inserted).toBe(true)

        const persisted = JSON.parse(
          (await adapter.getItem(TRANSACTIONS_STORAGE_KEY))!,
        ) as Transaction[]
        expect(persisted).toHaveLength(2)
      } finally {
        globalEventEmitter.offIncomingTransfer(throwingListener)
      }
    })

    it("findByTxHash returns a previously inserted receive row", async () => {
      const { transactions } = setup()
      await transactions.addIncomingTokenTransaction(sampleIncoming())

      const found = await transactions.findByTxHash("0xtx-incoming-1")
      expect(found).not.toBeNull()
      expect(found?.action).toBe("receive")
      expect(found?.txHash).toBe("0xtx-incoming-1")
    })

    it("findByTxHash returns null when no token row matches", async () => {
      const { transactions } = setup()
      await transactions.addIncomingTokenTransaction(sampleIncoming())

      const found = await transactions.findByTxHash("0xnope")
      expect(found).toBeNull()
    })

    it("findByTxHash also matches outgoing rows by txHash", async () => {
      const { transactions } = setup()
      await transactions.addTokenTransaction(
        "send",
        sampleToken(),
        "success",
        "0xoutgoing",
        "bob",
        undefined,
      )

      const found = await transactions.findByTxHash("0xoutgoing")
      expect(found).not.toBeNull()
      expect(found?.action).toBe("send")
    })

    it("findByTxHash matches regardless of hex casing", async () => {
      const { transactions } = setup()
      await transactions.addIncomingTokenTransaction(sampleIncoming({ txHash: "0xabcdef1234" }))

      const found = await transactions.findByTxHash("0xABCDEF1234")
      expect(found?.txHash).toBe("0xabcdef1234")
    })

    it("findReceivesByRequestId returns every matching receive case-insensitively", async () => {
      const { transactions } = setup()
      const requestId = "0x" + "0c".repeat(32)
      await transactions.addIncomingTokenTransaction(sampleIncoming({ txHash: "0xshort" }))
      await transactions.addIncomingTokenTransaction(
        sampleIncoming({ txHash: "0xsufficient", requestId: requestId.toUpperCase() }),
      )
      await transactions.addIncomingTokenTransaction(
        sampleIncoming({ txHash: "0xother", requestId: "0x" + "0d".repeat(32) }),
      )

      expect(
        (await transactions.findReceivesByRequestId(requestId)).map((tx) => tx.txHash),
      ).toEqual(["0xshort", "0xsufficient"])
    })

    it("collapses case-replayed transfers into a single normalized row", async () => {
      const { transactions, adapter } = setup()

      const first = await transactions.addIncomingTokenTransaction(
        sampleIncoming({ txHash: "0xabcdef1234" }),
      )
      const replay = await transactions.addIncomingTokenTransaction(
        sampleIncoming({ txHash: "0xABCDEF1234" }),
      )

      expect(first.inserted).toBe(true)
      expect(replay.inserted).toBe(false)

      const persisted = JSON.parse(
        (await adapter.getItem(TRANSACTIONS_STORAGE_KEY))!,
      ) as Transaction[]
      expect(persisted).toHaveLength(1)
      expect(persisted[0].txHash).toBe("0xabcdef1234")
    })
  })
})

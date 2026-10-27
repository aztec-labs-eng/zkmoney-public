import { describe, it, expect, beforeEach, vi, afterEach } from "vitest"

// Mock backend
vi.mock("src/core", async () => {
  const actual = await vi.importActual("src/core")
  return {
    ...actual,
    DEFAULT_DECIMALS: 18,
  }
})

import { TxLifecycleService, TransactionStorage, TransactionTracker } from "src/core"
import {
  QueueStatus,
  TransactionProgress,
  PaylinkActionEnum,
  TokenActionEnum,
} from "@obsidion/sdk"
import type { TokenInTxService, Transaction, FaucetActionEnum } from "src/types"
import { TOKEN_ACTIONS } from "src/core/services/transactions/constants"
import EventEmitter from "eventemitter3"

// Mock the services
vi.mock("src/core/storages/TransactionStorage")
vi.mock("src/core/services/transactions/TransactionTracker")

describe("TxLifecycleService", () => {
  let manager: TxLifecycleService
  let mockQueueService: any
  let mockTransactionStorage: any
  let mockToken: TokenInTxService

  beforeEach(() => {
    // Clear all mocks
    vi.clearAllMocks()

    // Reset singleton instance
    // @ts-expect-error - accessing private property for testing
    TxLifecycleService.instance = null

    // Get fresh instance
    manager = TxLifecycleService.getInstance()

    // Setup mock token
    mockToken = {
      name: "Ethereum",
      symbol: "ETH",
      decimals: 18,
      address: "0xtoken123",
      amount: 1000,
      hasUnknownAmount: false,
      logo: "https://example.com/eth.png",
      price: 2000,
    }

    // Setup mock queue service
    mockQueueService = {
      addToQueue: vi.fn().mockReturnValue("queue123"),
      updateStatus: vi.fn(),
      getQueue: vi.fn().mockReturnValue([
        {
          id: "queue123",
          status: QueueStatus.PENDING,
          progress: 0,
          description: "Test transaction",
          startTime: Date.now(),
        },
      ]),
    }
    vi.mocked(TransactionTracker.getInstance).mockReturnValue(mockQueueService)

    // Setup mock transaction service
    mockTransactionStorage = {
      addTokenTransaction: vi.fn(),
      addFaucetTransaction: vi.fn(),
      createPaylinkTransaction: vi.fn(),
      updateActiveTransactionsFromQueue: vi.fn(),
      updateTransactionCompletion: vi.fn(),
      getTransactions: vi.fn().mockResolvedValue([]),
      checkTransactionStatuses: vi.fn().mockResolvedValue(undefined),
      clearTransactions: vi.fn(),
      disableMonitoring: vi.fn(),
      isMonitoring: vi.fn().mockReturnValue(false),
    }

    // Mock TransactionStorage instance methods via the singleton getter
    vi.mocked(TransactionStorage.get).mockReturnValue(
      mockTransactionStorage as unknown as TransactionStorage,
    )
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe("getInstance", () => {
    it("should return singleton instance", () => {
      const instance1 = TxLifecycleService.getInstance()
      const instance2 = TxLifecycleService.getInstance()
      expect(instance1).toBe(instance2)
    })
  })

  describe("createTransaction", () => {
    it("should create token transaction", () => {
      const queueId = "queue123"
      const txHash = "0xtxhash123"
      const action = TokenActionEnum.SEND
      const recipient = "0xrecipient123"

      manager.recordTransaction(queueId, txHash, action, {
        token: mockToken,
        recipient,
        status: QueueStatus.PENDING,
      })

      expect(mockTransactionStorage.addTokenTransaction).toHaveBeenCalledWith(
        action,
        mockToken,
        "pending",
        txHash,
        recipient,
        queueId,
        undefined,
      )
    })

    it("should create faucet transaction", () => {
      const queueId = "queue123"
      const txHash = "0xtxhash123"
      const action = "faucet" as FaucetActionEnum

      manager.recordTransaction(queueId, txHash, action, {
        token: mockToken,
        status: QueueStatus.PENDING,
      })

      expect(mockTransactionStorage.addFaucetTransaction).toHaveBeenCalledWith(
        mockToken,
        "pending",
        txHash,
        queueId,
      )
    })

    it("should create paylink transaction", () => {
      const queueId = "queue123"
      const txHash = "0xtxhash123"
      const action = PaylinkActionEnum.PAY
      const recipient = "user@example.com"

      manager.recordTransaction(queueId, txHash, action, {
        flavor: "email",
        token: mockToken,
        recipient,
        payToEmailSecret: "secret123",
      })

      expect(mockTransactionStorage.createPaylinkTransaction).toHaveBeenCalledWith(
        queueId,
        txHash,
        action,
        "email",
        mockToken,
        recipient,
        "secret123",
        undefined,
        undefined,
        undefined,
        undefined,
      )
    })

    it("should create paylink transaction with flavor='zk'", () => {
      // Locks the third member of the widened flavor union — without this,
      // a future validator narrowing would silently regress ZK claim rows.
      const queueId = "queue-zk"
      const txHash = "0xtxhash-zk"
      const action = PaylinkActionEnum.CLAIM

      manager.recordTransaction(queueId, txHash, action, {
        flavor: "zk",
        token: mockToken,
      })

      expect(mockTransactionStorage.createPaylinkTransaction).toHaveBeenCalledWith(
        queueId,
        txHash,
        action,
        "zk",
        mockToken,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
      )
    })

    it("should handle unknown action type by updating transaction hash with error", () => {
      const queueId = "queue123"
      const txHash = "0xtxhash123"
      const unknownAction = "unknown" as any

      // Should not throw, but update transaction hash with error
      manager.recordTransaction(queueId, txHash, unknownAction)

      // Verify updateTransactionHash was called with error message
      expect(mockQueueService.updateStatus).toHaveBeenCalledWith(
        queueId,
        QueueStatus.MINING,
        TransactionProgress.MINING,
        "Unknown action type",
        txHash,
      )
    })

    it("should handle missing token for token transaction gracefully", () => {
      const queueId = "queue123"
      const txHash = "0xtxhash123"
      const action = TokenActionEnum.SEND

      // Should not throw - errors are caught and logged
      manager.recordTransaction(queueId, txHash, action)

      // Token transaction should not be added
      expect(mockTransactionStorage.addTokenTransaction).not.toHaveBeenCalled()
      // Should still update transaction hash with error
      expect(mockQueueService.updateStatus).toHaveBeenCalledWith(
        queueId,
        QueueStatus.MINING,
        TransactionProgress.MINING,
        "Unknown action type",
        txHash,
      )
    })

  })

  describe("createQueueEntry", () => {
    it("should create queue entry with default duration", async () => {
      const description = "Test Operation"

      const queueId = await manager.createQueueEntry(description)

      expect(mockQueueService.addToQueue).toHaveBeenCalledWith(description, 120000)
      expect(queueId).toBe("queue123")
    })

    it("should create queue entry with custom duration", async () => {
      const description = "Custom Operation"
      const customDuration = 300000

      const queueId = await manager.createQueueEntry(description, customDuration)

      expect(mockQueueService.addToQueue).toHaveBeenCalledWith(description, customDuration)
      expect(queueId).toBe("queue123")
    })
  })

  describe("startTransaction", () => {
    it("should start transaction with automatic queue management", async () => {
      const action = TokenActionEnum.SEND
      const description = "Send ETH"
      const estimatedDuration = 120000
      const params = {
        token: mockToken,
        recipient: "0xrecipient123",
      }
      const txHash = "0xtxhash123"

      //start tracking tx
      const queueId = await manager.startTrackingTx(action, 120000, new EventEmitter())

      await manager.recordTransaction(queueId, txHash, action, params)

      // Verify queue was created
      expect(mockQueueService.addToQueue).toHaveBeenCalledWith("Sending Token", estimatedDuration)
      expect(queueId).toBe("queue123")

      // Verify transaction was created with txHash
      expect(mockTransactionStorage.addTokenTransaction).toHaveBeenCalledWith(
        action,
        mockToken,
        undefined,
        txHash,
        params.recipient,
        "queue123",
        undefined,
      )
    })

    it("should handle transaction without token parameter", async () => {
      const action = TokenActionEnum.SEND
      const txHash = "0xtxhash123"

      //start tracking tx
      const queueId = await manager.startTrackingTx(action, 120000, new EventEmitter())

      // Should not throw - errors are caught and logged
      manager.recordTransaction(queueId, txHash, action)

      // No token transaction should be created
      expect(mockTransactionStorage.addTokenTransaction).not.toHaveBeenCalled()
    })
  })

  describe("updateTransactionHash", () => {
    it("should update queue and transaction with tx hash", () => {
      const queueId = "queue123"
      const txHash = "0xtxhash123"

      manager.updateTransactionHash(queueId, txHash)

      // Verify queue was updated
      expect(mockQueueService.updateStatus).toHaveBeenCalledWith(
        queueId,
        QueueStatus.MINING,
        TransactionProgress.MINING,
        undefined,
        txHash,
      )

      // Verify transaction was synced
      expect(mockQueueService.getQueue).toHaveBeenCalled()
      expect(mockTransactionStorage.updateActiveTransactionsFromQueue).toHaveBeenCalledWith([
        expect.objectContaining({ id: "queue123" }),
      ])
    })

    it("should handle missing queue item gracefully", () => {
      mockQueueService.getQueue.mockReturnValue([])

      // Should not throw
      expect(() => {
        manager.updateTransactionHash("nonexistent", "0xtxhash")
      }).not.toThrow()

      expect(mockTransactionStorage.updateActiveTransactionsFromQueue).not.toHaveBeenCalled()
    })
  })

  describe("completeTransaction", () => {
    it("should complete successful transaction", () => {
      const queueId = "queue123"
      const txHash = "0xtxhash123"

      manager.completeTransaction(queueId, QueueStatus.SUCCESS, txHash)

      // Verify queue update
      expect(mockQueueService.updateStatus).toHaveBeenCalledWith(
        queueId,
        QueueStatus.SUCCESS,
        TransactionProgress.SUCCESS,
        undefined,
        txHash,
      )

      // Verify transaction completion
      expect(mockTransactionStorage.updateTransactionCompletion).toHaveBeenCalledWith(
        queueId,
        QueueStatus.SUCCESS,
        expect.any(Number),
      )
    })

    it("should complete failed transaction with error", () => {
      const queueId = "queue123"
      const error = "Transaction reverted"

      manager.completeTransaction(queueId, QueueStatus.FAILED, undefined, error)

      // Verify queue update
      expect(mockQueueService.updateStatus).toHaveBeenCalledWith(
        queueId,
        QueueStatus.FAILED,
        TransactionProgress.FAILED,
        error,
        undefined,
      )

      // Verify transaction completion
      expect(mockTransactionStorage.updateTransactionCompletion).toHaveBeenCalledWith(
        queueId,
        QueueStatus.FAILED,
        expect.any(Number),
      )
    })
  })

  describe("updateTransactionProgress", () => {
    it("should update transaction progress from service events", () => {
      const queueId = "queue123"
      const status = QueueStatus.PROVING_AND_SENDING
      const progress = 50
      const txHash = "0xtxhash123"

      // Update queue item to reflect new status
      mockQueueService.getQueue.mockReturnValue([
        {
          id: "queue123",
          status,
          progress,
          txHash,
          description: "Test transaction",
          startTime: Date.now(),
        },
      ])

      manager.updateTransactionProgress(queueId, status, progress, txHash)

      // Verify queue update
      expect(mockQueueService.updateStatus).toHaveBeenCalledWith(
        queueId,
        status,
        progress,
        undefined,
        txHash,
      )

      // Verify transaction sync
      expect(mockTransactionStorage.updateActiveTransactionsFromQueue).toHaveBeenCalledWith([
        expect.objectContaining({
          id: "queue123",
          status,
          progress,
          txHash,
        }),
      ])
    })
  })

  describe("getTransactions", () => {
    it("should return all transactions", async () => {
      const mockTransactions: Transaction[] = [
        {
          action: TOKEN_ACTIONS.SEND,
          token: mockToken,
          status: "success",
          txHash: "0xtx1",
          timestamp: Date.now(),
        },
        {
          action: TOKEN_ACTIONS.SEND,
          token: mockToken,
          status: "pending",
          txHash: "0xtx2",
          timestamp: Date.now(),
        },
      ]

      mockTransactionStorage.getTransactions.mockResolvedValue(mockTransactions)

      const result = await manager.getTransactions()

      expect(result).toEqual(mockTransactions)
      expect(mockTransactionStorage.getTransactions).toHaveBeenCalled()
    })
  })

  describe("getActiveTransactions", () => {
    it("should return only pending transactions", async () => {
      const mockTransactions: Transaction[] = [
        {
          action: TOKEN_ACTIONS.SEND,
          token: mockToken,
          status: "success",
          txHash: "0xtx1",
          timestamp: Date.now(),
        },
        {
          action: TOKEN_ACTIONS.SEND,
          token: mockToken,
          status: "pending",
          txHash: "0xtx2",
          timestamp: Date.now(),
        },
        {
          action: TOKEN_ACTIONS.SEND,
          token: mockToken,
          status: "failed",
          txHash: "0xtx3",
          timestamp: Date.now(),
        },
      ]

      mockTransactionStorage.getTransactions.mockResolvedValue(mockTransactions)

      const result = await manager.getActiveTransactions()

      expect(result).toHaveLength(1)
      expect(result[0]).toMatchObject({
        status: "pending",
        txHash: "0xtx2",
      })
    })

    it("should return empty array when no pending transactions", async () => {
      const mockTransactions: Transaction[] = [
        {
          action: TOKEN_ACTIONS.SEND,
          token: mockToken,
          status: "success",
          txHash: "0xtx1",
          timestamp: Date.now(),
        },
      ]

      mockTransactionStorage.getTransactions.mockResolvedValue(mockTransactions)

      const result = await manager.getActiveTransactions()

      expect(result).toHaveLength(0)
    })
  })

  describe("clearTransactions", () => {
    it("should clear all transactions", () => {
      manager.clearTransactions()

      expect(mockTransactionStorage.clearTransactions).toHaveBeenCalled()
    })
  })

  describe("edge cases", () => {
    it("should handle queue service errors gracefully", async () => {
      mockQueueService.addToQueue.mockImplementation(() => {
        throw new Error("Queue service error")
      })
      const txHash = "0xtxhash123"

      // Should not throw - errors are caught and logged
      manager.recordTransaction("queue123", txHash, TOKEN_ACTIONS.SEND)

      // Transaction should not be added if queue fails
      expect(mockTransactionStorage.addTokenTransaction).not.toHaveBeenCalled()
    })

    it("should handle empty queue when updating progress", () => {
      mockQueueService.getQueue.mockReturnValue([])

      // Should not throw
      expect(() => {
        manager.updateTransactionProgress("queue123", QueueStatus.PENDING, 0)
      }).not.toThrow()

      expect(mockTransactionStorage.updateActiveTransactionsFromQueue).not.toHaveBeenCalled()
    })

    it("should handle missing required parameters for recordTransaction gracefully", () => {
      const queueId = "queue123"
      const txHash = "0xtxhash123"

      // Missing token for faucet transaction - should not throw
      manager.recordTransaction(queueId, txHash, "faucet" as FaucetActionEnum)
      expect(mockTransactionStorage.addFaucetTransaction).not.toHaveBeenCalled()

      // Clear mocks before next test
      vi.clearAllMocks()

      // Email payment transaction with all required params should work
      manager.recordTransaction(queueId, txHash, PaylinkActionEnum.PAY, {
        token: mockToken,
        recipient: "user@example.com",
        flavor: "email",
      })
      expect(mockTransactionStorage.createPaylinkTransaction).toHaveBeenCalled()

      vi.clearAllMocks()

      // Paylink action without `flavor` is rejected — silent default would
      // mislabel direct rows as email and the read-time projection cannot
      // recover (the heuristic only fires for legacy rows missing `flavor`).
      manager.recordTransaction(queueId, txHash, PaylinkActionEnum.PAY, {
        token: mockToken,
        recipient: "user@example.com",
      })
      expect(mockTransactionStorage.createPaylinkTransaction).not.toHaveBeenCalled()
    })
  })
})

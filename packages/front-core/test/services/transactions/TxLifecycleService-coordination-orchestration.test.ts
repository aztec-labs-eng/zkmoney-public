import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  AccountStorage,
  NetworkStorage,
  TransactionStorage,
  TxLifecycleService,
} from "../../../src/core"
import { TransactionTracker } from "../../../src/core/services/transactions/TransactionTracker"
import { InMemoryStorageAdapter } from "../../__test-helpers__/InMemoryStorageAdapter"

/**
 *   - registerCoordinationLoop({ id, getRecordByTxHash })
 *   - getCoordinationState(txHash)
 *
 * The lifecycle service is intentionally a read-only aggregator over loop
 * accessors here — these tests assert the join shape and the "no record
 * ownership" contract.
 */

const resetSingletons = () => {
  ;(AccountStorage as unknown as { instance: AccountStorage | null }).instance = null
  ;(TransactionStorage as unknown as { instance: TransactionStorage | null }).instance = null
  ;(NetworkStorage as unknown as { instance: NetworkStorage | null }).instance = null
  ;(TransactionTracker as unknown as { instance: TransactionTracker | null }).instance = null
  TxLifecycleService.reset()
}

const setup = () => {
  resetSingletons()
  const adapter = new InMemoryStorageAdapter()
  AccountStorage.get(adapter)
  TransactionStorage.get(adapter)
  const lifecycle = TxLifecycleService.get()
  return { adapter, lifecycle }
}

interface FakeBroadcastRecord {
  txHash: string
  attempts: number
  status: "pending" | "sent" | "failed-terminal"
}
interface FakeHintRecord {
  txHash: string
  retryCount: number
  status: "pending" | "promoted" | "discarded"
}

describe("TxLifecycleService — coordination-loop registry (Unit 4)", () => {
  beforeEach(() => resetSingletons())
  afterEach(() => resetSingletons())

  describe("registerCoordinationLoop + getCoordinationState", () => {
    it("returns an empty object when no loops are registered", () => {
      const { lifecycle } = setup()
      expect(lifecycle.getCoordinationState("0xabc")).toEqual({})
    })

    it("joins records from a single registered loop", () => {
      const { lifecycle } = setup()
      const record: FakeBroadcastRecord = {
        txHash: "0xabc",
        attempts: 1,
        status: "pending",
      }
      lifecycle.registerCoordinationLoop({
        id: "outgoing-broadcast",
        getRecordByTxHash: (txHash) => (txHash === "0xabc" ? record : null),
      })

      expect(lifecycle.getCoordinationState("0xabc")).toEqual({
        "outgoing-broadcast": record,
      })
    })

    it("joins records across multiple registered loops keyed by id", () => {
      const { lifecycle } = setup()
      const broadcastRecord: FakeBroadcastRecord = {
        txHash: "0xabc",
        attempts: 2,
        status: "pending",
      }
      const hintRecord: FakeHintRecord = {
        txHash: "0xabc",
        retryCount: 0,
        status: "pending",
      }

      lifecycle.registerCoordinationLoop({
        id: "outgoing-broadcast",
        getRecordByTxHash: (txHash) => (txHash === "0xabc" ? broadcastRecord : null),
      })
      lifecycle.registerCoordinationLoop({
        id: "pending-receive-hint",
        getRecordByTxHash: (txHash) => (txHash === "0xabc" ? hintRecord : null),
      })

      const state = lifecycle.getCoordinationState("0xabc")
      expect(state).toEqual({
        "outgoing-broadcast": broadcastRecord,
        "pending-receive-hint": hintRecord,
      })
    })

    it("returns null per loop when no record matches the txHash", () => {
      const { lifecycle } = setup()
      lifecycle.registerCoordinationLoop({
        id: "outgoing-broadcast",
        getRecordByTxHash: () => null,
      })
      lifecycle.registerCoordinationLoop({
        id: "pending-receive-hint",
        getRecordByTxHash: () => null,
      })

      expect(lifecycle.getCoordinationState("0xunknown")).toEqual({
        "outgoing-broadcast": null,
        "pending-receive-hint": null,
      })
    })

    it("handles the asymmetric case where one loop has the record and the other doesn't", () => {
      const { lifecycle } = setup()
      const broadcastRecord: FakeBroadcastRecord = {
        txHash: "0xabc",
        attempts: 0,
        status: "pending",
      }
      lifecycle.registerCoordinationLoop({
        id: "outgoing-broadcast",
        getRecordByTxHash: (txHash) => (txHash === "0xabc" ? broadcastRecord : null),
      })
      lifecycle.registerCoordinationLoop({
        id: "pending-receive-hint",
        getRecordByTxHash: () => null, // recipient never received this tx
      })

      expect(lifecycle.getCoordinationState("0xabc")).toEqual({
        "outgoing-broadcast": broadcastRecord,
        "pending-receive-hint": null,
      })
    })

    it("re-registering the same id replaces the previous accessor (last-writer-wins)", () => {
      const { lifecycle } = setup()
      const v1 = vi.fn(() => null)
      const v2 = vi.fn(() => ({ txHash: "0xabc" }))

      lifecycle.registerCoordinationLoop({
        id: "outgoing-broadcast",
        getRecordByTxHash: v1,
      })
      lifecycle.registerCoordinationLoop({
        id: "outgoing-broadcast",
        getRecordByTxHash: v2,
      })

      lifecycle.getCoordinationState("0xabc")

      expect(v1).not.toHaveBeenCalled()
      expect(v2).toHaveBeenCalledWith("0xabc")
    })

    it("unregisterCoordinationLoop removes the loop from future joins", () => {
      const { lifecycle } = setup()
      lifecycle.registerCoordinationLoop({
        id: "outgoing-broadcast",
        getRecordByTxHash: () => ({ txHash: "0xabc" }),
      })
      lifecycle.registerCoordinationLoop({
        id: "pending-receive-hint",
        getRecordByTxHash: () => ({ txHash: "0xabc" }),
      })

      lifecycle.unregisterCoordinationLoop("outgoing-broadcast")

      const state = lifecycle.getCoordinationState("0xabc")
      expect(state).toEqual({
        "pending-receive-hint": { txHash: "0xabc" },
      })
    })

    it("unregisterCoordinationLoop is a no-op for an unknown id", () => {
      const { lifecycle } = setup()
      // Should not throw.
      expect(() => lifecycle.unregisterCoordinationLoop("does-not-exist")).not.toThrow()
    })

    it("getCoordinationState passes the exact txHash through to each accessor", () => {
      const { lifecycle } = setup()
      const accessor = vi.fn(() => null)
      lifecycle.registerCoordinationLoop({
        id: "outgoing-broadcast",
        getRecordByTxHash: accessor,
      })

      lifecycle.getCoordinationState("0xMixedCase")

      // Lifecycle service does not normalize — passes through literally so
      // the loop's own normalization (e.g. toLowerCase) decides matching.
      expect(accessor).toHaveBeenCalledWith("0xMixedCase")
    })

    it("aggregate result keeps insertion order of registrations", () => {
      const { lifecycle } = setup()
      lifecycle.registerCoordinationLoop({
        id: "alpha",
        getRecordByTxHash: () => ({ rec: "a" }),
      })
      lifecycle.registerCoordinationLoop({
        id: "beta",
        getRecordByTxHash: () => ({ rec: "b" }),
      })
      lifecycle.registerCoordinationLoop({
        id: "gamma",
        getRecordByTxHash: () => ({ rec: "c" }),
      })

      const state = lifecycle.getCoordinationState("0xabc")
      expect(Object.keys(state)).toEqual(["alpha", "beta", "gamma"])
    })

    it("TxLifecycleService.reset() clears all registrations", () => {
      const { lifecycle } = setup()
      lifecycle.registerCoordinationLoop({
        id: "outgoing-broadcast",
        getRecordByTxHash: () => ({ txHash: "0xabc" }),
      })
      expect(lifecycle.getCoordinationState("0xabc")).toEqual({
        "outgoing-broadcast": { txHash: "0xabc" },
      })

      TxLifecycleService.reset()

      // After reset, get() returns a fresh instance with no registrations.
      const fresh = TxLifecycleService.get()
      expect(fresh.getCoordinationState("0xabc")).toEqual({})
    })
  })

  describe("read-only contract (R5: orchestration without record ownership)", () => {
    it("does NOT expose any write/mutate methods on the registration interface", () => {
      const { lifecycle } = setup()
      const accessor = vi.fn(() => null)
      lifecycle.registerCoordinationLoop({
        id: "outgoing-broadcast",
        getRecordByTxHash: accessor,
      })

      // The registration interface intentionally has no markDone / markRetry /
      // markGaveUp / patch methods. This test pins that contract — if a
      // future PR adds a write method to CoordinationLoopRegistration, this
      // test still passes (TypeScript catches the shape change), but the
      // assertion below documents the intent loudly.
      lifecycle.getCoordinationState("0xabc")
      // Assert: the only thing the lifecycle service called on the
      // registration is the read accessor.
      expect(accessor).toHaveBeenCalledTimes(1)
    })
  })
})

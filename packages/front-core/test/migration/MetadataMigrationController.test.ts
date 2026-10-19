import { describe, expect, it, vi } from "vitest"
import { MetadataMigrationController } from "../../src/core/migration/MetadataMigrationController"
import { ApprovalGate } from "../../src/core/migration/savedApprovals"
import type { MetadataMigrationSteps } from "../../src/core/migration/metadataMigrationFlow"
import type { StorageLock } from "../../src/core/storages/adapter"

function fixture() {
  let raw: string | null = null
  const storage = {
    getItem: vi.fn(async () => raw),
    setItem: vi.fn(async (_key: string, next: string) => {
      raw = next
    }),
  }
  const steps: MetadataMigrationSteps = {
    binding: async () => "account-and-deployments",
    prepare: vi.fn(async () => "signed-plan"),
    observe: async () => ({
      bootstrapSpent: false,
      metadataSettled: false,
      messagesReady: false,
      recurringSponsorship: false,
      complete: false,
    }),
    broadcast: vi.fn(async (_plan, onTxHash) => {
      await onTxHash("tx-hash")
    }),
    fund: vi.fn(),
    subscribe: vi.fn(),
    recoverRemaining: vi.fn(),
  }
  let tail: Promise<unknown> = Promise.resolve()
  const lock: StorageLock = (fn) => {
    const next = tail.then(fn)
    tail = next.catch(() => {})
    return next
  }
  const make = () => new MetadataMigrationController(storage, steps, "migration", lock)
  return { storage, steps, make }
}

describe("MetadataMigrationController durability", () => {
  it("reloads without signing and does not rebroadcast a saved hash", async () => {
    const { make, steps } = fixture()
    await make().advance(true)
    const restarted = make()
    await restarted.load()
    expect(restarted.getSnapshot()?.bootstrapTx).toBe("tx-hash")
    expect(steps.prepare).toHaveBeenCalledTimes(1)
    await restarted.advance()
    expect(steps.broadcast).toHaveBeenCalledTimes(1)
  })

  it("serializes two contexts and re-reads storage inside the shared lock", async () => {
    const { make, steps } = fixture()
    await Promise.all([make().advance(true), make().advance(true)])
    expect(steps.prepare).toHaveBeenCalledTimes(1)
    expect(steps.broadcast).toHaveBeenCalledTimes(1)
  })

  it("prevents RPC submission when persisting the prepared hash fails", async () => {
    const { make, steps, storage } = fixture()
    const sent = vi.fn()
    steps.broadcast = async (_plan, onTxHash) => {
      await onTxHash("tx-hash")
      sent()
    }
    const save = storage.setItem.getMockImplementation()!
    storage.setItem.mockImplementation(async (key, next) => {
      if (JSON.parse(next).bootstrapTx) throw new Error("disk full")
      await save(key, next)
    })
    await expect(make().advance(true)).rejects.toThrow("disk full")
    expect(sent).not.toHaveBeenCalled()
  })
})

describe("the approval gate", () => {
  it("holds the running advance's signal, and none after it", async () => {
    const gate = new ApprovalGate()
    const seen: (AbortSignal | boolean | undefined)[] = []
    const steps = {
      binding: async () => "bound",
      prepare: async () => {
        seen.push(gate.signal, gate.prompts)
        return "plan"
      },
      ready: async () => {},
      observe: async () => ({
        bootstrapSpent: false,
        metadataSettled: false,
        messagesReady: false,
        recurringSponsorship: false,
        complete: false,
      }),
      broadcast: async () => {},
      fund: async () => {},
      subscribe: async () => {},
      recoverRemaining: async () => {},
    }
    const items = new Map<string, string>()
    const storage = {
      getItem: async (key: string) => items.get(key) ?? null,
      setItem: async (key: string, value: string) => void items.set(key, value),
    }
    const controller = new MetadataMigrationController(storage, steps, "key", undefined, gate)
    const run = new AbortController()

    await controller.advance(true, run.signal)

    expect(seen).toEqual([run.signal, true])
    expect(gate.signal).toBeUndefined()
    expect(gate.prompts).toBe(true)
  })
})

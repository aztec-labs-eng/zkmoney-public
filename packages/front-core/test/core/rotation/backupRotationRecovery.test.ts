import { TxStatus } from "@aztec-labs/stdlib/tx"
import { describe, expect, it, vi } from "vitest"
import {
  cancellable,
  noteRecovery,
  PUBLISH_BOUND,
  recoveryState,
  resumeRotation,
} from "../../../src/core/rotation/backupRotationFlow"
import { fundingLocalId } from "../../../src/engine/backupRotations"
import {
  funding,
  OWNER,
  SIPA,
  signedRecord,
  storedRotation,
  word,
} from "../../__test-helpers__/backupRotation"
import { balances, CORRUPT, finish, harness, receipt, reopen } from "./rotationFlowHarness"
import type { World } from "./rotationFlowHarness"

describe("recovery", () => {
  const RECOVERY = word(0xaa)
  /** A stranded attempt over a funding the portal released to its deposit address. */
  const stranded = async (over: Partial<World> = {}, record = {}) => {
    const made = harness({ balance: 1400n, ...over })
    made.world.rows.set(fundingLocalId("attempt-1"), {
      phase: "done",
      l2TxHash: word(30),
      withdrawalId: word(0x77),
      startTime: 5,
      recipient: SIPA,
    })
    await made.store.put(
      signedRecord("attention", {
        attention: "stranded",
        suspended: "funded",
        fundings: [funding({ outcome: "mined" })],
        publish: { count: PUBLISH_BOUND, history: [] },
        ...record,
      }),
    )
    return made
  }

  it("ends a stranded attempt at recovered once its recovery is settled, and a reload reads it", async () => {
    const { deps, store, storage } = await stranded()
    const parked = (await resumeRotation(deps, (await store.get(OWNER))!)).record
    expect(parked).toMatchObject({ phase: "attention", attention: "stranded" })
    const noted = await noteRecovery(deps, parked, RECOVERY)
    expect(noted).toMatchObject({ phase: "attention", recovery: { txHash: RECOVERY } })
    balances(deps, 0n, 1400n)
    const waiting = (await resumeRotation(deps, noted)).record
    expect(waiting).toMatchObject({ phase: "attention", attention: "stranded" })
    balances(deps, 0n, 0n)
    const ended = (await resumeRotation(deps, waiting)).record
    expect(ended).toMatchObject({
      phase: "recovered",
      attention: undefined,
      suspended: undefined,
      recovery: { txHash: RECOVERY },
      recovered: { txHash: RECOVERY },
      fundings: [{ outcome: "swept" }],
    })
    expect(ended.rotation?.sharedSecretSalt).toBeUndefined()
    expect(ended.rotation?.signature).toBeUndefined()
    expect(ended.backup.envelopeHex).toBeUndefined()
    const reloaded = await reopen(storage).get(OWNER)
    expect(reloaded).toEqual(ended)
    expect((await resumeRotation(deps, reloaded!)).record).toEqual(ended)
    expect(deps.fund).not.toHaveBeenCalled()
  })

  it("reads a recovery it did not see confirm from the chain", async () => {
    const { deps, store, world } = await stranded({ balance: 0n, recovery: RECOVERY })
    const ended = (await resumeRotation(deps, (await store.get(OWNER))!)).record
    expect(ended).toMatchObject({ phase: "recovered", recovery: { txHash: RECOVERY } })
    expect(deps.l1.recovery).toHaveBeenCalledWith(SIPA, 50)
    world.recovery = undefined
    await store.put(
      signedRecord("attention", {
        attention: "stranded",
        suspended: "funded",
        fundings: [funding({ outcome: "swept" })],
      }),
    )
    const released = (await resumeRotation(deps, (await store.get(OWNER))!)).record
    expect(released.phase).toBe("published")
  })

  it("keeps a recovery read from the chain while it settles, so the card shows it as sent", async () => {
    const { deps, store, storage, world } = await stranded({
      balance: 0n,
      recovery: RECOVERY,
      recoveryBlock: 120,
    })
    const waiting = await resumeRotation(deps, (await store.get(OWNER))!)
    expect(waiting).toMatchObject({
      record: { phase: "attention", attention: "stranded", recovery: { txHash: RECOVERY } },
      wait: "recovery",
    })
    expect(recoveryState(waiting.record)).toBe("sent")
    expect(await reopen(storage).get(OWNER)).toEqual(waiting.record)
    world.l1Settled = 130
    const ended = (await resumeRotation(deps, waiting.record)).record
    expect(ended).toMatchObject({ phase: "recovered", recovered: { txHash: RECOVERY } })
  })

  it("lets a sweep that lands first win over the recovery", async () => {
    const { deps, store, world } = await stranded({}, { recovery: { txHash: RECOVERY } })
    world.sweep = { index: "3", blockNumber: 60, blockHash: word(0x60), credited: 1400n }
    balances(deps, 0n, 0n)
    const swept = (await resumeRotation(deps, (await store.get(OWNER))!)).record
    expect(swept).toMatchObject({ phase: "swept", attention: undefined, recovery: undefined })
    expect(deps.verify).toHaveBeenCalled()
  })

  it("installs a change that ran anyway once its money is gone, instead of ending it at recovered", async () => {
    const { deps, store } = await stranded({ balance: 0n }, { recovery: { txHash: RECOVERY } })
    ;(deps.fundability as ReturnType<typeof vi.fn>).mockResolvedValue("applied")
    const record = (await resumeRotation(deps, (await store.get(OWNER))!)).record
    expect(record).toMatchObject({ phase: "rerooted" })
    expect(record.recovery).toBeUndefined()
  })

  // The install drops the salt later through the same empty-address read, so it waits as well.
  it("installs a change that ran anyway only once the recovery is settled", async () => {
    const { deps, store, world } = await stranded(
      { balance: 0n, recoveryBlock: 120 },
      { recovery: { txHash: RECOVERY } },
    )
    ;(deps.fundability as ReturnType<typeof vi.fn>).mockResolvedValue("applied")
    const waiting = await resumeRotation(deps, (await store.get(OWNER))!)
    expect(waiting).toMatchObject({
      record: { phase: "attention", attention: "stranded" },
      wait: "recovery",
    })
    world.l1Settled = 130
    const record = (await resumeRotation(deps, waiting.record)).record
    expect(record).toMatchObject({ phase: "rerooted" })
    expect(record.recovery).toBeUndefined()
  })

  it("holds a stranded attempt while its recovery has no receipt", async () => {
    const { deps, store } = await stranded({ balance: 0n }, { recovery: { txHash: RECOVERY } })
    ;(deps.l1.txBlock as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
    const waiting = await resumeRotation(deps, (await store.get(OWNER))!)
    expect(waiting).toMatchObject({
      record: { phase: "attention", attention: "stranded", recovery: { txHash: RECOVERY } },
      wait: "recovery",
    })
    expect(waiting.record.rotation?.sharedSecretSalt).toBe(word(9))
  })

  describe("a saved recovery with no block, and a later one on the chain", () => {
    const LATER = word(0xbb)
    const dropped = (deps: { l1: { txBlock: unknown } }, world: World) =>
      (deps.l1.txBlock as ReturnType<typeof vi.fn>).mockImplementation(async (hash) =>
        hash === RECOVERY ? undefined : { blockNumber: world.recoveryBlock, blockHash: word(0x70) },
      )

    it("waits on the later recovery, then ends a stranded attempt on it", async () => {
      const { deps, store, world } = await stranded(
        { balance: 0n, recovery: LATER, recoveryBlock: 120 },
        { recovery: { txHash: RECOVERY } },
      )
      dropped(deps, world)
      const waiting = await resumeRotation(deps, (await store.get(OWNER))!)
      expect(waiting).toMatchObject({
        record: { phase: "attention", recovery: { txHash: LATER } },
        wait: "recovery",
      })
      world.l1Settled = 130
      const ended = (await resumeRotation(deps, waiting.record)).record
      expect(ended).toMatchObject({ phase: "recovered", recovered: { txHash: LATER } })
      expect(ended.rotation?.sharedSecretSalt).toBeUndefined()
    })

    it("ends a damaged record on the later recovery", async () => {
      const { deps, store, world } = await stranded(
        { recovery: LATER },
        { attention: "corrupt", recovery: { txHash: RECOVERY } },
      )
      dropped(deps, world)
      balances(deps, 0n, 0n)
      const ended = (await resumeRotation(deps, (await store.get(OWNER))!)).record
      expect(ended).toMatchObject({ phase: "recovered", recovered: { txHash: LATER } })
    })

    // The chain's latest recovery may predate a saved one still pending.
    it("keeps the saved recovery while the address still holds money", async () => {
      const { deps, store, world } = await stranded(
        { recovery: LATER },
        { attention: "corrupt", recovery: { txHash: RECOVERY } },
      )
      dropped(deps, world)
      expect(await resumeRotation(deps, (await store.get(OWNER))!)).toMatchObject({
        record: { phase: "attention", recovery: { txHash: RECOVERY } },
        wait: "recovery",
      })
    })
  })

  it("ends a damaged record whose money was recovered, without judging it again", async () => {
    const { deps, store } = await stranded({}, { attention: "corrupt" })
    ;(deps.verify as ReturnType<typeof vi.fn>).mockResolvedValue(CORRUPT)
    const parked = (await store.get(OWNER))!
    expect(cancellable(parked)).toBe(false)
    const noted = await noteRecovery(deps, parked, RECOVERY)
    balances(deps, 0n, 1400n)
    expect(await resumeRotation(deps, noted)).toMatchObject({
      record: { phase: "attention", attention: "corrupt" },
      wait: "recovery",
    })
    balances(deps, 0n, 0n)
    const ended = (await resumeRotation(deps, (await store.get(OWNER))!)).record
    expect(ended).toMatchObject({ phase: "recovered", recovery: { txHash: RECOVERY } })
    expect(deps.verify).toHaveBeenCalledTimes(0)
  })

  it("ends a damaged record whose recovery confirmed after the tab closed, re-checking until it is settled", async () => {
    const { deps, store, world } = await stranded({}, { attention: "corrupt" })
    const parked = await resumeRotation(deps, (await store.get(OWNER))!)
    expect(parked.record).toMatchObject({ phase: "attention", attention: "corrupt" })
    expect(parked.wait).toBeUndefined()
    world.recovery = RECOVERY
    balances(deps, 0n, 1400n)
    expect(await resumeRotation(deps, (await store.get(OWNER))!)).toMatchObject({
      record: { phase: "attention", attention: "corrupt", recovery: { txHash: RECOVERY } },
      wait: "recovery",
    })
    balances(deps, 0n, 0n)
    const ended = (await resumeRotation(deps, (await store.get(OWNER))!)).record
    expect(ended).toMatchObject({ phase: "recovered", recovery: { txHash: RECOVERY } })
    expect(deps.verify).not.toHaveBeenCalled()
  })

  // A deposit not settled reads 0 at the settled block, and the recovery takes the latest to 0.
  it("holds a stranded attempt at Recovering while its deposit and recovery are above the settled block", async () => {
    const { deps, store, world } = harness({ recoveryBlock: 120 })
    await store.put(
      signedRecord("attention", {
        attention: "stranded",
        suspended: "published",
        recovery: { txHash: RECOVERY },
      }),
    )
    const waiting = await resumeRotation(deps, (await store.get(OWNER))!)
    expect(waiting).toMatchObject({
      record: { phase: "attention", attention: "stranded", recovery: { txHash: RECOVERY } },
      wait: "recovery",
    })
    expect(waiting.record.rotation?.sharedSecretSalt).toBe(word(9))
    expect(deps.l1.txBlock).toHaveBeenCalledWith(RECOVERY)
    world.l1Settled = 130
    const ended = (await resumeRotation(deps, waiting.record)).record
    expect(ended).toMatchObject({ phase: "recovered", recovery: { txHash: RECOVERY } })
    expect(ended.rotation?.sharedSecretSalt).toBeUndefined()
  })

  it("holds a finished attempt parked over late money until the recovery that took it is settled", async () => {
    const { deps, store, world } = harness({ recovery: RECOVERY, recoveryBlock: 120 })
    await store.put(
      finish(
        signedRecord("attention", {
          attention: "stranded",
          suspended: "done",
          sweep: { index: "3", blockHash: word(0x60), credited: "1400" },
          fundings: [funding({ outcome: "swept" })],
        }),
      ),
    )
    const waiting = await resumeRotation(deps, (await store.get(OWNER))!)
    expect(waiting).toMatchObject({
      record: { phase: "attention", recovery: { txHash: RECOVERY } },
      wait: "recovery",
    })
    expect(waiting.record.rotation?.sharedSecretSalt).toBe(word(9))
    world.l1Settled = 130
    const done = (await resumeRotation(deps, waiting.record)).record
    expect(done.phase).toBe("done")
    expect(done.rotation?.sharedSecretSalt).toBeUndefined()
  })

  /** A record parked as corrupt whose funding's tracker row names another L2 transaction. */
  const misfiled = async (over: Partial<World>, outcome: "pending" | "mined") => {
    const made = harness({ recovery: RECOVERY, ...over })
    made.world.rows.set(fundingLocalId("attempt-1"), {
      phase: "done",
      l2TxHash: word(31),
      withdrawalId: word(0x77),
      startTime: 5,
      recipient: SIPA,
    })
    await made.store.put(
      signedRecord("attention", {
        attention: "corrupt",
        suspended: "funded",
        fundings: [funding({ outcome })],
      }),
    )
    return made
  }

  it("ends a record parked as corrupt over a mismatched funding row once its recovery is settled", async () => {
    const { deps, store, world } = await misfiled({ recoveryBlock: 120 }, "pending")
    world.receipts.set(word(30), receipt(TxStatus.FINALIZED, true))
    const waiting = await resumeRotation(deps, (await store.get(OWNER))!)
    expect(waiting).toMatchObject({
      record: {
        phase: "attention",
        attention: "corrupt",
        fundings: [{ outcome: "reverted" }],
        recovery: { txHash: RECOVERY },
      },
      wait: "recovery",
    })
    world.l1Settled = 130
    const ended = (await resumeRotation(deps, waiting.record)).record
    expect(ended).toMatchObject({ phase: "recovered", recovery: { txHash: RECOVERY } })
    expect(ended.rotation?.sharedSecretSalt).toBeUndefined()
  })

  it("keeps polling a corrupt record whose mismatched funding is included but not yet mined", async () => {
    const { deps, store, world } = await misfiled({}, "pending")
    world.receipts.set(word(30), receipt(TxStatus.PROVEN))
    const waiting = await resumeRotation(deps, (await store.get(OWNER))!)
    expect(waiting).toMatchObject({
      record: { attention: "corrupt", fundings: [{ outcome: "pending" }] },
      wait: "recovery",
    })
    expect(deps.l1.releaseSettled).not.toHaveBeenCalled()
  })

  it("keeps a corrupt record at Recovering, with no wait to poll, while a mismatched row leaves its mined funding unreleased", async () => {
    const { deps, store } = await misfiled({}, "mined")
    const held = await resumeRotation(deps, (await store.get(OWNER))!)
    expect(held.record).toMatchObject({
      phase: "attention",
      attention: "corrupt",
      fundings: [{ outcome: "mined" }],
    })
    expect(held.wait).toBeUndefined()
    expect(held.record.rotation?.sharedSecretSalt).toBe(word(9))
    expect(deps.l1.releaseSettled).not.toHaveBeenCalled()
  })

  it("notes a recovery only on an attempt parked over its money", async () => {
    const { deps, store } = harness()
    await store.put(signedRecord("funded", { fundings: [funding()] }))
    await expect(noteRecovery(deps, (await store.get(OWNER))!, RECOVERY)).rejects.toThrow(
      "moved on",
    )
    await store.put(signedRecord("attention", { attention: "corrupt", suspended: "signed" }))
    await expect(noteRecovery(deps, (await store.get(OWNER))!, RECOVERY)).rejects.toThrow(
      "moved on",
    )
  })

  it("returns a finished attempt to done once a funding that landed after its sweep is recovered", async () => {
    const { deps, store } = harness({ balance: 1400n })
    const sweep = { index: "3", blockHash: word(0x60), credited: "1400" }
    await store.put(
      finish(
        signedRecord("attention", {
          attention: "stranded",
          suspended: "done",
          sweep,
          fundings: [funding({ outcome: "swept" })],
        }),
      ),
    )
    const parked = (await resumeRotation(deps, (await store.get(OWNER))!)).record
    expect(parked).toMatchObject({ phase: "attention", suspended: "done" })
    expect(parked.rotation?.sharedSecretSalt).toBe(storedRotation().sharedSecretSalt)
    const noted = await noteRecovery(deps, parked, RECOVERY)
    balances(deps, 0n, 0n)
    const done = (await resumeRotation(deps, noted)).record
    expect(done).toMatchObject({ phase: "done", sweep, recovery: { txHash: RECOVERY } })
    expect(done.rotation?.sharedSecretSalt).toBeUndefined()
  })

  it("parks a recovered attempt again over money that lands later, until that is recovered too", async () => {
    const { deps, store } = harness({ balance: 5n })
    // As `endRecovered` leaves it: nothing could land, so the salt left too.
    const stripped = finish(
      signedRecord("recovered", {
        recovery: { txHash: RECOVERY },
        recovered: { txHash: RECOVERY },
        fundings: [],
      }),
    )
    await store.put({
      ...stripped,
      rotation: { ...stripped.rotation!, sharedSecretSalt: undefined },
    })
    const parked = (await resumeRotation(deps, (await store.get(OWNER))!)).record
    expect(parked).toMatchObject({
      phase: "attention",
      attention: "stranded",
      suspended: "recovered",
      recovery: undefined,
      recovered: { txHash: RECOVERY },
    })
    const again = word(0xab)
    const noted = await noteRecovery(deps, parked, again)
    balances(deps, 0n, 0n)
    const ended = (await resumeRotation(deps, noted)).record
    // The later money's recovery never stands in for the one that ended the attempt.
    expect(ended).toMatchObject({
      phase: "recovered",
      recovery: { txHash: again },
      recovered: { txHash: RECOVERY },
    })
  })
})

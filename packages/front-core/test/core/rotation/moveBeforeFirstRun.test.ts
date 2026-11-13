// @vitest-environment node
/** Home's count of the one-key balance from a backup add's switch until its move plans a run. */
import { describe, expect, it, vi } from "vitest"
import { rerootRotation, resumeRotation } from "../../../src/core/rotation/backupRotationFlow"
import { balanceToMove } from "../../../src/engine/backupRotations"
import { OWNER, TWO_KEY, signedRecord } from "../../__test-helpers__/backupRotation"
import { DAI, harness } from "./rotationFlowHarness"

describe("the balance a backup add still has to move, before its first run", () => {
  it("counts the one-key account's balance from the switch while a paylink refund waits on approval", async () => {
    const { deps, store } = harness({ links: ["link-1"] })
    const owed = async () => balanceToMove([(await store.get(OWNER))!], TWO_KEY, "tok", undefined)
    await store.put(signedRecord("swept"))

    await rerootRotation(deps, (await store.get(OWNER))!)
    expect(await owed()).toBe(3n * DAI)

    const waiting = await resumeRotation(deps, (await store.get(OWNER))!)
    expect(waiting.wait).toBe("approval")
    expect(waiting.record.move).toBeUndefined()
    expect(await owed()).toBe(3n * DAI)
  })

  it("reads the one-key balance on the move's next step when the read at the switch failed", async () => {
    const { deps, store, world } = harness({ links: ["link-1"] })
    const shape = deps.move.shape
    deps.move.shape = vi.fn(async () => {
      throw new Error("node down")
    })
    await store.put(signedRecord("swept"))
    const rerooted = await rerootRotation(deps, (await store.get(OWNER))!)
    expect(rerooted.reroot).toEqual({ switched: true, rebound: true })

    deps.move.shape = shape
    const waiting = await resumeRotation(deps, rerooted)
    expect(waiting.wait).toBe("approval")
    expect(waiting.record.reroot?.oneKeyBalances).toEqual([
      { token: "tok", amount: `${world.shape.balance}` },
    ])
  })

  describe("with a token whose read fails", () => {
    const both = [
      { token: "tok", amount: `${3n * DAI}` },
      { token: "shares", amount: `${3n * DAI}` },
    ]
    const twoTokens = () => {
      const run = harness({ links: ["link-1"] })
      const fails = { shares: false }
      const shape = run.deps.move.shape
      run.deps.move.tokens = vi.fn(async () => ["tok", "shares"])
      run.deps.move.shape = vi.fn(async (token: string) => {
        if (token === "shares" && fails.shares) throw new Error("notes kept changing")
        return shape(token)
      })
      return { ...run, fails }
    }

    it("keeps the others at the switch and reads it before the first run", async () => {
      const { deps, store, fails } = twoTokens()
      await store.put(signedRecord("swept"))
      fails.shares = true
      const rerooted = await rerootRotation(deps, (await store.get(OWNER))!)
      expect(rerooted.reroot?.oneKeyBalances).toEqual([both[0]])

      fails.shares = false
      const waiting = await resumeRotation(deps, rerooted)
      expect(waiting.wait).toBe("approval")
      expect(waiting.record.reroot?.oneKeyBalances).toEqual(both)
    })

    it("keeps its earlier figure when a retry before the switch fails to read it", async () => {
      const { deps, store, fails } = twoTokens()
      const rebindFailed = new Error("rebind failed")
      vi.mocked(deps.reroot).mockRejectedValueOnce(rebindFailed)
      await store.put(signedRecord("swept"))
      await expect(rerootRotation(deps, (await store.get(OWNER))!)).rejects.toBe(rebindFailed)

      fails.shares = true
      const rerooted = await rerootRotation(deps, (await store.get(OWNER))!)
      expect(rerooted.reroot?.oneKeyBalances).toHaveLength(2)
      expect(rerooted.reroot?.oneKeyBalances).toEqual(expect.arrayContaining(both))
    })
  })

  it("keeps the read taken before the switch when the re-root resumes after it", async () => {
    const { deps, store, world } = harness()
    const before = [{ token: "tok", amount: `${3n * DAI}` }]
    await store.put(signedRecord("swept", { reroot: { switched: true, oneKeyBalances: before } }))
    world.shape = { notes: [], depositTotal: 0n, balance: 0n }
    const rerooted = await rerootRotation(deps, (await store.get(OWNER))!)
    expect(rerooted.reroot?.oneKeyBalances).toEqual(before)
  })
})

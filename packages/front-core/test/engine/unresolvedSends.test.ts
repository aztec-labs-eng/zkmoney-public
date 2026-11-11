import { describe, expect, it } from "vitest"
import { openDatabase } from "../../src/engine/database"
import { memoryBackend } from "../../src/engine/memoryBackend"
import { loadRecords } from "../../src/engine/persistentStore"
import type { SipaDeposit } from "../../src/engine/sipaDeposits"
import {
  createUnresolvedSends,
  depositsOffered,
  holdArrival,
  unresolvedSendState,
  unresolvedSendTransition,
  type UnresolvedSend,
} from "../../src/engine/unresolvedSends"

const NS = "obsidion.ns."
const LEGACY = "webwallet.deposit.unresolved-send.sandbox.0xacct"
const send: UnresolvedSend = { id: "send", address: "0xAb", at: 1, submission: "s1" }

function open(entries = new Map<string, string>(), legacyKey: string | undefined = LEGACY) {
  const page = openDatabase(memoryBackend(entries))
  return {
    entries,
    holds: createUnresolvedSends({ page, namespace: NS, legacyKey: () => legacyKey }),
  }
}

describe("unresolvedSendTransition", () => {
  const { id, ...fresh } = send
  void id
  it.each<
    [string, UnresolvedSend | undefined, Parameters<typeof unresolvedSendTransition>[1], unknown]
  >([
    ["holds a first send", undefined, { type: "held", send: fresh }, send],
    [
      "holds the same submission again",
      send,
      { type: "held", send: { ...fresh, at: 2 } },
      { ...send, at: 2 },
    ],
    ["clears a hold", send, { type: "cleared" }, null],
    [
      "clears a hold whose address matches",
      send,
      { type: "cleared", only: { address: "0xab" } },
      null,
    ],
    [
      "keeps a hold of another address",
      send,
      { type: "cleared", only: { address: "0xcd" } },
      undefined,
    ],
    [
      "keeps a hold of another submission",
      send,
      { type: "cleared", only: { submission: "s2" } },
      undefined,
    ],
    ["clears nothing when nothing is held", undefined, { type: "cleared" }, undefined],
  ])("%s", (_, saved, event, next) => {
    expect(unresolvedSendTransition(saved, event)).toEqual(next)
  })

  it.each([
    ["another submission", { ...fresh, submission: "s2" }],
    ["a send with no submission", { address: "0xab", at: 2 }],
  ])("refuses to replace a hold with %s", (_, next) => {
    expect(() => unresolvedSendTransition(send, { type: "held", send: next })).toThrow()
  })
})

describe("createUnresolvedSends", () => {
  it("carries the legacy marker into the namespace and removes it in the same write", async () => {
    const legacy = JSON.stringify({ address: "0xAb", at: 1, submission: "s1" })
    const { entries, holds } = open(new Map([[LEGACY, legacy]]))
    expect(await loadRecords(holds.view)).toEqual([send])
    expect(entries.has(LEGACY)).toBe(false)
  })

  it.each([
    ["does not parse", "{"],
    ["is no hold", JSON.stringify({ address: 7 })],
  ])("drops a legacy marker that %s, and opens with no hold", async (_, legacy) => {
    const { entries, holds } = open(new Map([[LEGACY, legacy]]))
    expect(await loadRecords(holds.view)).toEqual([])
    expect(entries.has(LEGACY)).toBe(false)
  })

  it("leaves a marker no address names: the account's own key is the only one carried", async () => {
    const legacy = JSON.stringify({ address: "0xAb", at: 1 })
    const unknown = "webwallet.deposit.unresolved-send.sandbox.unknown"
    const { entries, holds } = open(new Map([[unknown, legacy]]))
    expect(await loadRecords(holds.view)).toEqual([])
    expect(entries.get(unknown)).toBe(legacy)
  })

  it("saves a hold, refuses another submission's, and clears it", async () => {
    const { holds } = open()
    const { id, ...fresh } = send
    void id
    await holds.apply({ type: "held", send: fresh })
    await expect(
      holds.apply({ type: "held", send: { ...fresh, submission: "s2" } }),
    ).rejects.toThrow()
    expect(unresolvedSendState(holds.view.get())).toEqual({ status: "held", send })
    await holds.apply({ type: "cleared", only: { submission: "s1" } })
    expect(unresolvedSendState(holds.view.get())).toEqual({ status: "none" })
  })
})

describe("depositsOffered", () => {
  it.each([
    [{ status: "loading" }, false],
    [{ status: "unreadable" }, false],
    [{ status: "held", send }, false],
    [{ status: "none" }, true],
  ] as const)("is %j: %s", (state, open) => {
    expect(depositsOffered(state)).toBe(open)
  })
})

describe("holdArrival", () => {
  const record = (over: Partial<SipaDeposit>) =>
    ({ sipaAddress: "0xab", phase: "broadcast", amount: "0", ...over } as SipaDeposit)
  it("ends a hold once funds reach its address, not on the address's unfunded record", () => {
    const unfunded = record({})
    const funded = record({ amount: "5" })
    expect(holdArrival(send, [unfunded])).toBeUndefined()
    expect(holdArrival(send, [unfunded, funded])).toBe(funded)
    expect(holdArrival(send, [record({ sipaAddress: "0xcd", amount: "5" })])).toBeUndefined()
    expect(holdArrival(undefined, [funded])).toBeUndefined()
  })
})

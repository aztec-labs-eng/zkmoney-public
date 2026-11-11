// @vitest-environment node
/**
 * Earlier SIPA sets: a deployment that replaced its factory, table and implementations still holds
 * the addresses handed out under the set before. Discovery reads an event's address under each one.
 */
import { describe, expect, it } from "vitest"
import type { Address } from "viem"
import type { OxideEnvTuple } from "@obsidion/core/types"
import { sipaCursorKey, sipaSetsKey } from "../../../src/engine/sipaDeposits"
import {
  DAI,
  L2_TOKEN,
  pipelineWorld,
  PORTAL,
  RECIPIENT,
  salt,
  TUPLE,
  type PipelineWorld,
} from "./world"

const ONE = 10n ** 18n
const OLD_FACTORY = "0x00000000000000000000000000000000000001f1" as Address
const OLD_TABLE = "0x00000000000000000000000000000000000001f2" as Address
const OLD_IMPL = "0x00000000000000000000000000000000000001f3" as Address
/** A clone of the earlier factory under an implementation the manifest does not list. */
const UNLISTED_IMPL = "0x00000000000000000000000000000000000001f4" as Address
/** The earlier table's deposit fee, unlike the current one's. */
const OLD_FEE = 3n * 10n ** 17n

const REPLACED: OxideEnvTuple = {
  ...TUPLE,
  priorSipaGenerations: [
    { sipaFactory: OLD_FACTORY, forwardingTable: OLD_TABLE, depositSIPAImplementation: OLD_IMPL },
  ],
}

/** The earlier set's factory and table on the chain, answering for themselves. */
function earlierSet(w: PipelineWorld) {
  const factory = w.l1.contract(OLD_FACTORY, "factory")
  const table = w.l1.contract(OLD_TABLE, "table")
  table.row(DAI, 1, { portal: w.l1.contracts.portals[0]!, sweepTip: OLD_FEE })
  return { factory, table }
}

/** An event the account's PXE holds for an address handed out under the earlier set. */
async function earlierAddress(w: PipelineWorld, n: number, implementation = OLD_IMPL) {
  const sipa = await w.derive(salt(n), {
    sipaFactory: OLD_FACTORY,
    forwardingTable: OLD_TABLE,
    implementation,
  })
  w.l2.emit(L2_TOKEN, sipa.recipient, { salt: sipa.salt, intentHash: sipa.intentHash })
  return sipa
}

const scan = { tuple: REPLACED }
const pass = { scan, claim: { tuple: REPLACED } }

describe("earlier SIPA sets", () => {
  it("files a swept deposit at its earlier set's address, with that set's origin, priced on its table, and claims it", async () => {
    const w = await pipelineWorld()
    earlierSet(w)
    const sipa = await earlierAddress(w, 1)
    w.pay(sipa.address, ONE)
    w.sweep(sipa, 7n)

    const { claimed } = await w.pass(pass)

    expect(claimed).toMatchObject({ claimed: 1, failed: 0 })
    expect(await w.get(sipa.address)).toMatchObject({
      phase: "claimed",
      fee: OLD_FEE.toString(),
      origin: {
        protocol: "account",
        sipaFactory: OLD_FACTORY,
        forwardingTable: OLD_TABLE,
        implementation: OLD_IMPL,
      },
    })
  })

  it("files a funded, unswept earlier-set address with what it holds", async () => {
    const w = await pipelineWorld()
    earlierSet(w)
    const sipa = await earlierAddress(w, 1)
    w.pay(sipa.address, ONE)

    await w.pass({ scan })

    expect(await w.get(sipa.address)).toMatchObject({
      heldBalance: ONE.toString(),
      origin: { sipaFactory: OLD_FACTORY },
    })
  })

  it("keeps reading an unfunded event's earlier-set address, and files it once funds arrive", async () => {
    const w = await pipelineWorld()
    earlierSet(w)
    const sipa = await earlierAddress(w, 1)
    await w.pass({ scan })
    expect(await w.get(sipa.address)).toBeUndefined()

    w.pay(sipa.address, ONE)
    w.sweep(sipa, 7n)
    await w.pass(pass)

    expect(await w.get(sipa.address)).toMatchObject({
      phase: "claimed",
      origin: { sipaFactory: OLD_FACTORY },
    })
  })

  it("backfills an earlier set the cursor was not read with, once", async () => {
    const w = await pipelineWorld()
    earlierSet(w)
    const sipa = await earlierAddress(w, 1)
    w.pay(sipa.address, ONE, DAI, w.l1.head - 600n)
    w.sweep(sipa, 7n, { block: w.l1.head - 500n })
    // A pass that did not know the earlier set leaves the event a record and the cursor at the head.
    await w.pass()
    w.l1.head += 1000n

    await w.pass(pass)
    expect(await w.get(sipa.address)).toMatchObject({
      phase: "claimed",
      origin: { sipaFactory: OLD_FACTORY },
    })

    const cursor = (await w.cursor())!
    w.l1.head += 1n
    w.l1.calls.length = 0
    await w.scan(scan)
    const starts = w.l1.calls.filter((c) => c.range).map((c) => c.range![0])
    expect(starts.every((start) => start >= cursor - 128n)).toBe(true)
  })

  it("leaves the backfill to a discovery pass when a pass without events runs first", async () => {
    const w = await pipelineWorld()
    earlierSet(w)
    const sipa = await earlierAddress(w, 1)
    w.pay(sipa.address, ONE, DAI, w.l1.head - 600n)
    w.sweep(sipa, 7n, { block: w.l1.head - 500n })
    await w.pass()
    w.l1.head += 1000n

    await w.scan({ ...scan, discover: false })
    await w.pass(pass)

    expect(await w.get(sipa.address)).toMatchObject({
      phase: "claimed",
      origin: { sipaFactory: OLD_FACTORY },
    })
  })

  it("files an earlier set's stray with its origin in a pass without events, then reads only the head", async () => {
    const w = await pipelineWorld()
    const { factory } = earlierSet(w)
    const sipa = await earlierAddress(w, 1)
    factory.intentOf.set(sipa.address.toLowerCase(), 1)
    await w.pass()
    w.pay(sipa.address, ONE)
    w.sweep(sipa, 7n)
    w.l1.head += 1n

    await w.scan({ ...scan, discover: false })
    expect(await w.get(sipa.address)).toMatchObject({
      origin: { sipaFactory: OLD_FACTORY, forwardingTable: OLD_TABLE, implementation: OLD_IMPL },
    })

    await w.pass(pass)
    expect(await w.get(sipa.address)).toMatchObject({ phase: "claimed", fee: OLD_FEE.toString() })
    w.l1.calls.length = 0
    await w.scan({ ...scan, discover: false })
    expect(w.l1.count({ method: "eth_getLogs" })).toBe(0)
  })

  it("ignores a deposit to its commitment that no factory's clone made, and keeps reading only the head", async () => {
    const w = await pipelineWorld()
    earlierSet(w)
    const sipa = await w.announced(1)
    await w.pass(pass)
    const forger = "0x00000000000000000000000000000000000000d5" as Address
    w.pay(forger, ONE)
    w.sweep({ address: forger, commitment: sipa.commitment }, 9n)
    w.l1.head += 1n

    await w.scan({ ...scan, discover: false })
    expect(await w.get(forger)).toBeUndefined()
    w.l1.calls.length = 0
    await w.scan({ ...scan, discover: false })
    expect(w.l1.count({ method: "eth_getLogs" })).toBe(0)
  })

  it("keeps an unread stray's block on a claimed address paid again whose republish waits", async () => {
    const w = await pipelineWorld()
    const { factory } = earlierSet(w)
    const sipa = await w.announced(1, { resweepable: true })
    w.pay(sipa.address, ONE, DAI, w.l1.head - 510n)
    w.sweep(sipa, 7n, { block: w.l1.head - 500n })
    await w.pass(pass)
    expect(await w.get(sipa.address)).toMatchObject({ phase: "claimed" })
    const clone = await w.derive(salt(1), {
      sipaFactory: OLD_FACTORY,
      forwardingTable: OLD_TABLE,
      implementation: UNLISTED_IMPL,
    })
    factory.intentOf.set(clone.address.toLowerCase(), 1)
    w.l1.head += 1000n
    w.pay(sipa.address, ONE)
    w.pay(clone.address, ONE, DAI, w.l1.head - 600n)
    w.sweep(clone, 8n, { block: w.l1.head - 500n })

    w.l2.headError = new Error("node down")
    w.l1.failing = (c) => c.method === "eth_getTransactionReceipt"
    await w.scan({ ...scan, discover: false })
    w.l1.failing = () => false
    w.l2.headError = undefined
    w.l1.head += 1000n
    await w.scan(scan)

    expect(await w.get(clone.address)).toMatchObject({ messageSecret: salt(1).toString() })
  })

  it("files an earlier-set stray beside a funded event with its origin", async () => {
    const w = await pipelineWorld()
    const { factory } = earlierSet(w)
    const sipa = await w.announced(1)
    w.pay(sipa.address, ONE)
    w.sweep(sipa, 7n)
    await w.pass(pass)
    const earlier = await w.derive(salt(1), {
      sipaFactory: OLD_FACTORY,
      forwardingTable: OLD_TABLE,
      implementation: OLD_IMPL,
    })
    factory.intentOf.set(earlier.address.toLowerCase(), 1)
    w.pay(earlier.address, ONE)
    w.sweep(earlier, 8n)

    await w.pass(pass)

    expect(await w.get(earlier.address)).toMatchObject({
      origin: { sipaFactory: OLD_FACTORY, implementation: OLD_IMPL },
    })
  })

  it("fills the origin of an earlier-set record filed without one", async () => {
    const w = await pipelineWorld()
    earlierSet(w)
    const sipa = await earlierAddress(w, 1)
    await w.saved(sipa, { phase: "broadcast", replayed: true })
    w.pay(sipa.address, ONE)
    w.sweep(sipa, 7n)

    await w.pass(pass)

    expect(await w.get(sipa.address)).toMatchObject({
      phase: "claimed",
      origin: { sipaFactory: OLD_FACTORY, forwardingTable: OLD_TABLE },
    })
  })

  it("leaves a record whose plan failed under a new set its whole history to re-read, and records the set", async () => {
    const w = await pipelineWorld()
    earlierSet(w)
    await w.db.write(async (tx) =>
      tx.put(sipaCursorKey(PORTAL, RECIPIENT.toString()), String(w.l1.head - 1n)),
    )
    const observedFrom = (w.l1.head - 1_000n).toString()
    await w.saved(await w.announced(2), { phase: "broadcast", observedFrom })
    const failing = await w.derive(salt(1))
    await w.saved(failing, { phase: "broadcast", intent: "registration", observedFrom })
    const registration = w.l1.implementations.get(2)!
    w.l1.implementations.delete(2)

    await w.scan(scan)
    const backfill = w.l1.calls.find((c) => c.range)!.range![0]
    expect(await w.get(failing.address)).toMatchObject({ rescanFrom: backfill.toString() })
    expect(await w.db.get(sipaSetsKey(RECIPIENT.toString()))).toBeDefined()

    w.l1.implementations.set(2, registration)
    const cursor = (await w.cursor())!
    w.l1.head += 1n
    w.l1.calls.length = 0
    await w.scan(scan)
    const starts = new Set(w.l1.calls.filter((c) => c.range).map((c) => c.range![0]))
    expect(starts).toEqual(new Set([backfill, cursor - 128n]))
  })

  it("adopts a stray that only the earlier set's factory vouches for", async () => {
    const w = await pipelineWorld()
    const { factory } = earlierSet(w)
    const clone = await earlierAddress(w, 1, UNLISTED_IMPL)
    factory.intentOf.set(clone.address.toLowerCase(), 1)
    w.pay(clone.address, ONE)
    w.sweep(clone, 7n)

    await w.scan(scan)

    expect(await w.get(clone.address)).toMatchObject({
      messageSecret: salt(1).toString(),
      replayed: true,
    })
  })

  it("reads every event's earlier-set addresses in the pass's own requests", async () => {
    const w = await pipelineWorld()
    earlierSet(w)
    for (const n of [1, 2, 3]) await w.announced(n)

    await w.scan(scan)
    w.l1.head += 1n
    w.l1.calls.length = 0
    await w.scan(scan)

    expect(w.l1.count({ method: "eth_getLogs" })).toBe(3)
    expect(w.l1.count({ fn: "aggregate3" })).toBe(1)
  })

  it("stops reading the earlier-set address once the event's own address shows funds", async () => {
    const w = await pipelineWorld()
    earlierSet(w)
    const sipa = await w.announced(1)
    w.pay(sipa.address, ONE)
    w.sweep(sipa, 7n)
    await w.pass(pass)
    const earlier = await w.derive(salt(1), {
      sipaFactory: OLD_FACTORY,
      forwardingTable: OLD_TABLE,
      implementation: OLD_IMPL,
    })
    w.pay(earlier.address, ONE)

    await w.pass(pass)

    expect(await w.get(sipa.address)).toMatchObject({ phase: "claimed" })
    expect(await w.get(earlier.address)).toBeUndefined()
  })
})

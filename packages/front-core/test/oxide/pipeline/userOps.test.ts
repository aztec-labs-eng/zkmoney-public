// @vitest-environment node
/**
 * User-operation SIPAs (a backup passkey rotation's funding): their event reads as a registration
 * until the clone of a blessed implementation is swept, and a stray deposit is filed by the factory.
 */
import { describe, expect, it } from "vitest"
import type { Address, Hex } from "viem"
import { sipaCursorKey } from "../../../src/engine/sipaDeposits"
import {
  DAI,
  FACTORY,
  L2_TOKEN,
  pipelineWorld,
  PORTAL,
  RECIPIENT,
  REGISTRATION_IMPL,
  salt,
  USER_OP_IMPL,
  type PipelineWorld,
} from "./world"

const ONE = 10n ** 18n
const USER_OP_HASH = `0x${"88".repeat(32)}` as Hex
const EARLIER_IMPL = "0x0000000000000000000000000000000000000c04" as Address
const FORGER = "0x00000000000000000000000000000000000000ff" as Address

/** One user operation's event, and the addresses it can resolve to. */
async function userOp(w: PipelineWorld, earlierBlessed = false) {
  if (earlierBlessed) {
    w.l1.bless(3, EARLIER_IMPL, 0n)
    w.l1.implementations.set(3, USER_OP_IMPL)
  }
  const registration = await w.announced(1, {
    intentHash: USER_OP_HASH,
    implementation: REGISTRATION_IMPL,
  })
  const clone = await w.derive(salt(1), { intentHash: USER_OP_HASH, implementation: USER_OP_IMPL })
  const earlier = await w.derive(salt(1), {
    intentHash: USER_OP_HASH,
    implementation: EARLIER_IMPL,
  })
  return { registration, clone, earlier }
}

const swept = (w: PipelineWorld, sipa: { address: Address; commitment: Hex }, index = 5n) => {
  w.pay(sipa.address, ONE)
  return w.sweep(sipa, index)
}

/** The factory's bless logs cannot be read. */
const blessedListDown = (w: PipelineWorld) => {
  const factory = (params: unknown) =>
    String((params as { address?: string }[])[0]?.address).toLowerCase() === FACTORY.toLowerCase()
  w.l1.failing = (c) => c.method === "eth_getLogs" && factory(c.params)
}

describe("user-op SIPAs", () => {
  it("stores a swept user-op SIPA at its clone, prices it on the user-op row and claims it with its message key", async () => {
    const w = await pipelineWorld()
    const { registration, clone } = await userOp(w)
    const { key } = swept(w, clone)
    const intents: number[] = []
    w.l1.reverts = (_t, fn, args) =>
      void (fn === "rowFor" && intents.push(Number(args[1]))) as never

    const { claimed } = await w.pass()

    expect(claimed).toMatchObject({ claimed: 1, failed: 0 })
    expect(await w.get(registration.address)).toBeUndefined()
    expect(await w.get(clone.address)).toMatchObject({
      intent: "user-op",
      phase: "claimed",
      replayed: true,
      origin: expect.objectContaining({ implementation: USER_OP_IMPL }),
      sweeps: [expect.objectContaining({ inboxIndex: "5", messageKey: key })],
    })
    expect(intents).toContain(3)
  })

  it("reads the blessed list once a pass, from the pass's history start, and none for plain deposits", async () => {
    const w = await pipelineWorld()
    const { clone } = await userOp(w)
    swept(w, clone)
    await w.scan({ historyStartBlock: async () => 600_000n })
    const factoryReads = () => w.l1.calls.filter((c) => c.method === "eth_getLogs").length
    // Deposits, outflows, fundings, and the factory's blesses.
    expect(factoryReads()).toBe(4)

    const plain = await pipelineWorld()
    swept(plain, await plain.announced(1))
    await plain.pass()
    expect(plain.l1.count({ method: "eth_getLogs" })).toBe(3)
    expect((await plain.records())[0]).toMatchObject({ phase: "claimed" })
  })

  it("reads a user-op event as a registration until its clone is swept, then moves it", async () => {
    const w = await pipelineWorld()
    const { registration, clone } = await userOp(w)
    await w.scan()
    expect(await w.get(registration.address)).toMatchObject({
      intent: "registration",
      replayed: true,
    })
    expect(await w.get(clone.address)).toBeUndefined()

    w.l1.head += 10n
    swept(w, clone)
    await w.pass()

    expect(await w.get(registration.address)).toBeUndefined()
    expect(await w.get(clone.address)).toMatchObject({ intent: "user-op", phase: "claimed" })
  })

  it("resolves an event as a registration when the blessed list cannot be read, and re-reads its window once it can", async () => {
    const w = await pipelineWorld()
    const { registration, clone } = await userOp(w)
    swept(w, clone)
    const plain = await w.announced(2)
    swept(w, plain, 6n)
    blessedListDown(w)

    expect((await w.pass()).claimed).toMatchObject({ claimed: 1, failed: 0 })
    expect(await w.get(plain.address)).toMatchObject({ phase: "claimed" })
    expect(await w.get(registration.address)).toMatchObject({
      intent: "registration",
      observedFrom: w.l1.head.toString(),
      rescanFrom: (w.l1.head - 100_000n).toString(),
    })
    expect(await w.get(clone.address)).toBeUndefined()

    w.l1.failing = () => false
    w.l1.head += 10n
    expect((await w.pass()).claimed).toMatchObject({ claimed: 1, failed: 0 })
    expect(await w.get(registration.address)).toBeUndefined()
    expect(await w.get(clone.address)).toMatchObject({ intent: "user-op", phase: "claimed" })
  })

  it("reads a failing blessed list once a pass, however many events need it", async () => {
    const w = await pipelineWorld()
    const a = await userOp(w)
    const b = await w.announced(2, {
      intentHash: `0x${"99".repeat(32)}`,
      implementation: REGISTRATION_IMPL,
    })
    blessedListDown(w)

    expect(await w.scan()).toMatchObject({ failed: 0, complete: false })
    // One whole-history read, then its chunks: one list read.
    const reads = w.l1.calls.filter((c) => c.method === "eth_getLogs" && c.range?.[0] === 0n)
    expect(reads).toHaveLength(1)
    for (const address of [a.registration.address, b.address])
      expect(await w.get(address)).toMatchObject({
        intent: "registration",
        rescanFrom: (w.l1.head - 100_000n).toString(),
      })
  })

  it("fails only the event of a recorded user operation no blessed implementation derives", async () => {
    const w = await pipelineWorld()
    const { earlier } = await userOp(w)
    await w.saved(earlier, { phase: "broadcast", intent: "user-op", amount: "0" })
    const plain = await w.announced(2)
    swept(w, plain, 6n)

    const { scanned, claimed } = await w.pass()

    expect(scanned.failed).toBe(1)
    expect(claimed.claimed).toBe(1)
    expect((await w.get(earlier.address))?.origin).toBeUndefined()
    expect(await w.get(plain.address)).toMatchObject({ phase: "claimed" })
  })

  it("lands a rotation prepared on an earlier implementation at that clone after a newer bless", async () => {
    const w = await pipelineWorld()
    const { registration, clone, earlier } = await userOp(w, true)
    swept(w, earlier)

    await w.pass()

    expect(await w.get(earlier.address)).toMatchObject({
      intent: "user-op",
      phase: "claimed",
      origin: expect.objectContaining({ implementation: EARLIER_IMPL }),
    })
    expect(await w.get(clone.address)).toBeUndefined()
    expect(await w.get(registration.address)).toBeUndefined()
  })

  it("records and claims every swept user-op clone of one intent, not only the first blessed", async () => {
    const w = await pipelineWorld()
    const { registration, clone, earlier } = await userOp(w, true)
    swept(w, clone)
    swept(w, earlier, 6n)

    const { claimed } = await w.pass()

    expect(claimed).toMatchObject({ claimed: 2, failed: 0 })
    for (const [sipa, implementation] of [
      [clone, USER_OP_IMPL],
      [earlier, EARLIER_IMPL],
    ] as const)
      expect(await w.get(sipa.address)).toMatchObject({
        intent: "user-op",
        phase: "claimed",
        origin: expect.objectContaining({ implementation }),
      })
    expect(await w.get(registration.address)).toBeUndefined()
  })

  it("scans a swept clone whose record has no salt yet, which no plan of its own reads", async () => {
    const w = await pipelineWorld()
    const { clone, earlier } = await userOp(w, true)
    await w.saved(earlier, {
      phase: "sweeping",
      replayed: true,
      amount: "0",
      messageSecret: "",
      startTime: 1,
    })
    swept(w, clone)
    swept(w, earlier, 6n)

    const { scanned, claimed } = await w.pass()

    // The event's clone is new and the recorded one was sweeping: both were in flight.
    expect(scanned.active).toBe(2)
    expect(claimed).toMatchObject({ claimed: 2, failed: 0 })
    expect(await w.get(earlier.address)).toMatchObject({
      intent: "user-op",
      phase: "claimed",
      messageSecret: salt(1).toString(),
      origin: expect.objectContaining({ implementation: EARLIER_IMPL }),
    })
  })

  it("leaves a swept clone recorded under another account to that account", async () => {
    const w = await pipelineWorld()
    const { clone, earlier } = await userOp(w, true)
    await w.saved(earlier, {
      phase: "broadcast",
      replayed: true,
      amount: "0",
      messageSecret: "",
      recipientL2Address: `0x${"09".repeat(32)}`,
    })
    const theirs = await w.get(earlier.address)
    swept(w, clone)
    swept(w, earlier, 6n)

    expect((await w.pass()).claimed).toMatchObject({ claimed: 1, failed: 0 })
    expect(await w.get(earlier.address)).toEqual(theirs)
  })

  it("scans a clone once when a misfiled record and the clone's own record both pin the event", async () => {
    const w = await pipelineWorld()
    const { registration, clone } = await userOp(w)
    await w.saved(registration, {
      phase: "broadcast",
      replayed: true,
      amount: "0",
      intent: "registration",
    })
    await w.saved(clone, { phase: "broadcast", replayed: true, amount: "0", intent: "user-op" })
    swept(w, clone)

    expect((await w.pass()).claimed).toMatchObject({ claimed: 1, failed: 0 })
    expect(await w.get(registration.address)).toBeUndefined()
    expect(await w.get(clone.address)).toMatchObject({ intent: "user-op", phase: "claimed" })
  })

  it("backfills a clone first recorded under a cursor window before it rides the cursor", async () => {
    const w = await pipelineWorld()
    await w.db.write(async (tx) =>
      tx.put(sipaCursorKey(PORTAL, RECIPIENT.toString()), String(w.l1.head - 500n)),
    )
    const { registration, clone } = await userOp(w)
    await w.saved(registration, {
      phase: "broadcast",
      replayed: true,
      intent: "registration",
      amount: "0",
      observedFrom: (w.l1.head - 1_000n).toString(),
    })
    swept(w, clone)

    expect((await w.pass()).claimed).toMatchObject({ claimed: 1, failed: 0 })
    expect(await w.get(registration.address)).toBeUndefined()
    expect((await w.get(clone.address))?.observedFrom).toBeUndefined()

    w.l1.head += 10n
    await w.scan()
    expect(w.l1.calls.some((c) => c.range?.[0] === w.l1.head - 100_000n)).toBe(true)
    expect(await w.get(clone.address)).toMatchObject({ observedFrom: w.l1.head.toString() })
  })

  it("keeps an event whose swept clone sits under no blessed implementation a registration", async () => {
    const w = await pipelineWorld()
    const { registration, earlier } = await userOp(w)
    swept(w, earlier)

    await w.pass()

    expect(await w.get(registration.address)).toMatchObject({ intent: "registration" })
    expect(await w.get(earlier.address)).toBeUndefined()
  })

  it.each([
    ["user operation first", true],
    ["deposit first", false],
  ])(
    "keeps a user-op SIPA and a deposit SIPA sharing its salt apart, %s, across passes",
    async (_, first) => {
      const w = await pipelineWorld()
      const deposit = await w.derive(salt(1))
      const emitDeposit = () =>
        w.l2.emit(L2_TOKEN, RECIPIENT, { salt: deposit.salt, intentHash: deposit.intentHash })
      if (!first) emitDeposit()
      const { clone } = await userOp(w)
      if (first) emitDeposit()
      swept(w, clone)

      await w.pass()
      w.l1.head += 10n
      await w.pass()

      expect((await w.records()).map((r) => r.sipaAddress.toLowerCase()).sort()).toEqual(
        [deposit.address, clone.address].map((a) => a.toLowerCase()).sort(),
      )
      expect(await w.get(clone.address)).toMatchObject({ intent: "user-op" })
      expect((await w.get(deposit.address))?.intent).toBeUndefined()
    },
  )

  it("leaves a funded registration alone and reads no blessed list for it", async () => {
    const w = await pipelineWorld()
    const { registration, clone } = await userOp(w)
    await w.saved(registration, {
      phase: "claimed",
      intent: "registration",
      amount: "5",
      inboxIndex: "1",
      endTime: 1,
    })
    swept(w, clone)

    await w.pass()

    expect(w.l1.count({ method: "eth_getLogs" })).toBe(3)
    expect(await w.get(registration.address)).toMatchObject({
      intent: "registration",
      phase: "claimed",
    })
    expect(await w.get(clone.address)).toBeUndefined()
  })

  it("keeps stray funds at a misfiled address and gives the user operation its own record", async () => {
    const w = await pipelineWorld()
    const { registration, clone } = await userOp(w)
    await w.saved(registration, {
      phase: "recoverable",
      replayed: true,
      intent: "registration",
      amount: "0.000001",
    })
    w.l1.setBalance(registration.address, DAI, 10n ** 12n)
    swept(w, clone)

    await w.pass()
    w.l1.head += 10n
    await w.pass()

    expect(await w.get(registration.address)).toMatchObject({
      intent: "registration",
      amount: "0.000001",
    })
    expect(await w.get(clone.address)).toMatchObject({
      intent: "user-op",
      phase: "claimed",
      origin: expect.objectContaining({ implementation: USER_OP_IMPL }),
    })
  })
})

describe("strays", () => {
  /** A deposit to the event's commitment from a clone no plan tracks. */
  async function stray(w: PipelineWorld, opts: { forger?: boolean } = {}) {
    const op = await userOp(w)
    w.pay(op.earlier.address, ONE)
    w.l1.sweep({
      sipa: op.earlier.address,
      token: DAI,
      gross: ONE,
      credit: ONE / 2n,
      index: 3n,
      commitment: op.earlier.commitment,
      portal: PORTAL,
      block: w.l1.head - 5n,
      alsoEmitted: opts.forger ? [FORGER] : [],
    })
    return op
  }

  it("files an adopted stray by the factory's intent, not by what the blessed list could show", async () => {
    const w = await pipelineWorld()
    blessedListDown(w)
    const { earlier } = await stray(w)
    w.l1.intentOf.set(earlier.address.toLowerCase(), 3)

    expect(await w.scan()).toMatchObject({ failed: 0, complete: false })
    expect(await w.get(earlier.address)).toMatchObject({
      intent: "user-op",
      messageSecret: salt(1).toString(),
      replayed: true,
    })
  })

  it("leaves a stray whose intent the factory did not answer for the next pass", async () => {
    const w = await pipelineWorld()
    const { earlier } = await stray(w)
    w.l1.intentOf.set(earlier.address.toLowerCase(), 3)
    let failures = 1
    w.l1.failing = (c) => c.fn === "sipaIntentOf" && failures-- > 0

    expect(await w.scan()).toMatchObject({ failed: 0 })
    expect(await w.get(earlier.address)).toBeUndefined()
    w.l1.head += 1n
    expect(await w.scan()).toMatchObject({ failed: 0 })
    expect(await w.get(earlier.address)).toMatchObject({ intent: "user-op" })
  })

  it("adopts the stray's clone the factory vouches for, past a forged sweep log ahead of it", async () => {
    const w = await pipelineWorld()
    const { earlier } = await stray(w, { forger: true })
    w.l1.intentOf.set(earlier.address.toLowerCase(), 3)

    expect(await w.scan()).toMatchObject({ failed: 0 })
    expect(await w.get(FORGER)).toBeUndefined()
    expect(await w.get(earlier.address)).toMatchObject({
      intent: "user-op",
      messageSecret: salt(1).toString(),
      replayed: true,
    })
  })

  it("claims an adopted stray from its clone's own implementation while the blessed list stays unread", async () => {
    const w = await pipelineWorld()
    const { earlier } = await userOp(w)
    // As adoption files it: the factory's intent, no origin.
    await w.saved(earlier, { phase: "broadcast", intent: "user-op", amount: "0" })
    w.l1.cloneImplementation.set(earlier.address.toLowerCase(), EARLIER_IMPL)
    blessedListDown(w)
    swept(w, earlier)

    expect((await w.pass()).claimed).toMatchObject({ claimed: 1, failed: 0 })
    expect(await w.get(earlier.address)).toMatchObject({
      phase: "claimed",
      intent: "user-op",
      origin: expect.objectContaining({ implementation: EARLIER_IMPL }),
    })
  })

  it("follows a recorded user operation's origin without reading the blessed list", async () => {
    const w = await pipelineWorld()
    const { earlier } = await userOp(w)
    await w.saved(earlier, {
      phase: "broadcast",
      intent: "user-op",
      amount: "0",
      origin: { implementation: EARLIER_IMPL } as never,
    })
    swept(w, earlier)

    expect((await w.pass()).claimed).toMatchObject({ claimed: 1, failed: 0 })
    expect(w.l1.count({ method: "eth_getLogs" })).toBe(3)
  })

  it("backfills a recorded user operation's origin from the blessed implementation that derives it", async () => {
    const w = await pipelineWorld()
    const { earlier } = await userOp(w, true)
    await w.saved(earlier, { phase: "broadcast", intent: "user-op", amount: "0" })

    await w.scan()

    expect(await w.get(earlier.address)).toMatchObject({
      intent: "user-op",
      origin: expect.objectContaining({ implementation: EARLIER_IMPL }),
    })
  })
})

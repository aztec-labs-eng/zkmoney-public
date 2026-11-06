// @vitest-environment node
/** Discovery: what the account's `SIPA` events and its own records tell the pass to observe. */
import { describe, expect, it } from "vitest"
import type { Address, Hex } from "viem"
import type { OxideEnvTuple } from "@obsidion/core/types"
import {
  DAI,
  FEE,
  L2_TOKEN,
  pipelineWorld,
  RECIPIENT,
  REGISTRATION_IMPL,
  salt,
  TUPLE,
} from "./world"

const ONE = 10n ** 18n
const ELSEWHERE = "0x00000000000000000000000000000000000000b2" as Address
const OTHER_RECIPIENT = `0x${"09".repeat(32)}`
const REGISTRATION_HASH = `0x${"77".repeat(32)}` as Hex

/** Which intents the pass priced a fee for, in order. */
const pricedIntents = (w: Awaited<ReturnType<typeof pipelineWorld>>) => {
  const intents: number[] = []
  w.l1.reverts = (_target, fn, args) => {
    if (fn === "rowFor") intents.push(Number(args[1]))
    return false
  }
  return intents
}

describe("discovery", () => {
  it("discovers an event, reads its settled sweep, claims it and lands the record on claimed", async () => {
    const w = await pipelineWorld()
    const sipa = await w.announced(1)
    w.pay(sipa.address, ONE)
    const block = w.l1.head - 40n
    const sweep = w.sweep(sipa, 7n, { block })

    const { scanned, claimed } = await w.pass()

    expect(scanned).toMatchObject({ discovered: 1, failed: 0, complete: true, replaying: true })
    expect(claimed).toMatchObject({ claimed: 1, failed: 0, complete: true })
    expect(w.l2.claims).toEqual([
      { l2Token: L2_TOKEN, inboxIndex: 7n, amount: ONE - FEE, salt: sipa.salt.toString() },
    ])
    expect(await w.get(sipa.address)).toMatchObject({
      phase: "claimed",
      inboxIndex: "7",
      claimedInboxIndexes: ["7"],
      sweeps: [
        {
          inboxIndex: "7",
          sweepTxHash: sweep.tx,
          settledAt: Number(w.l1.timeOf(block)) * 1000,
          netAmount: (ONE - FEE).toString(),
          grossAmount: ONE.toString(),
          fundingTokenSymbol: "DAI",
          fee: FEE.toString(),
        },
      ],
      netAmount: (ONE - FEE).toString(),
      fee: FEE.toString(),
      amount: "0.9",
      sweepTxHash: sweep.tx,
      messageSecret: sipa.salt.toString(),
      recipientL2Address: RECIPIENT.toString(),
      tokenAddress: DAI,
      replayed: true,
    })
  })

  it("processes a duplicated event once and isolates per-event failures", async () => {
    const w = await pipelineWorld()
    const a = await w.announced(1)
    w.l2.emit(L2_TOKEN, RECIPIENT, { salt: a.salt, intentHash: a.intentHash })
    const b = await w.announced(2)
    for (const [sipa, index] of [
      [a, 1n],
      [b, 3n],
    ] as const) {
      w.pay(sipa.address, ONE)
      w.sweep(sipa, index)
    }
    w.l2.claimError = (index) => (index === 1n ? new Error("pxe hiccup") : undefined)

    const { scanned, claimed } = await w.pass()

    expect(scanned.discovered).toBe(2)
    expect(claimed).toMatchObject({ claimed: 1, failed: 1 })
    expect(await w.get(b.address)).toMatchObject({ phase: "claimed" })
  })

  it("reports the claim run's progress over its sweeps, failed ones included", async () => {
    const w = await pipelineWorld()
    for (const [n, index] of [
      [1, 3n],
      [2, 4n],
    ] as const) {
      const sipa = await w.announced(n)
      w.pay(sipa.address, ONE)
      w.sweep(sipa, index)
    }
    w.l2.claimError = (index) => (index === 3n ? new Error("pxe hiccup") : undefined)
    const progress: [number, number][] = []

    await w.pass({ claim: { onProgress: (done, total) => progress.push([done, total]) } })

    expect(progress).toEqual([
      [0, 2],
      [1, 2],
      [2, 2],
    ])
  })

  it("backfills empty discovery-derived fields on an existing self-initiated record", async () => {
    const w = await pipelineWorld()
    const sipa = await w.announced(1)
    await w.saved(sipa, { phase: "funded", messageSecret: "", recipientHash: "", amount: "1.0" })

    await w.scan()

    expect(await w.get(sipa.address)).toMatchObject({
      phase: "funded",
      messageSecret: sipa.salt.toString(),
      recipientHash: sipa.commitment,
      amount: "1.0",
    })
  })

  it("leaves a fully populated existing record untouched by the backfill", async () => {
    const w = await pipelineWorld()
    const sipa = await w.announced(1)
    await w.saved(sipa, { phase: "broadcast", recoveryAddress: "0xoldrecovery" })
    const before = await w.get(sipa.address)

    await w.scan()

    expect(await w.get(sipa.address)).toMatchObject({
      messageSecret: before!.messageSecret,
      recipientHash: before!.recipientHash,
      recoveryAddress: "0xoldrecovery",
    })
  })

  it("fails fast on a staging-shaped tuple (no SIPA surface)", async () => {
    const w = await pipelineWorld()
    const tuple = { ...TUPLE, sipaFactory: undefined } as unknown as OxideEnvTuple
    await expect(w.scan({ tuple })).rejects.toMatchObject({ code: "config.invalid" })
  })
})

describe("self-initiated records", () => {
  it("claims a record with no event at its recorded address", async () => {
    const w = await pipelineWorld()
    const sipa = { ...(await w.derive(salt(2))), address: ELSEWHERE }
    await w.saved(sipa, { phase: "broadcast" })
    w.pay(sipa.address, ONE)
    w.sweep(sipa, 3n)

    const { claimed } = await w.pass()

    expect(claimed).toMatchObject({ claimed: 1, failed: 0 })
    expect(await w.get(ELSEWHERE)).toMatchObject({ phase: "claimed", claimedInboxIndexes: ["3"] })
  })

  it("skips another recipient's record, and watches a settled one without claiming", async () => {
    const w = await pipelineWorld()
    const theirs = { ...(await w.derive(salt(2))), address: ELSEWHERE }
    await w.saved(theirs, { phase: "broadcast", recipientL2Address: OTHER_RECIPIENT })
    const settled = await w.derive(salt(3))
    await w.saved(settled, { phase: "claimed", endTime: 1 })
    w.pay(theirs.address, ONE)
    w.sweep(theirs, 4n)

    const { scanned, claimed } = await w.pass()

    expect(scanned).toMatchObject({ failed: 0 })
    expect(claimed.claimed).toBe(0)
    expect(await w.get(ELSEWHERE)).toMatchObject({ phase: "broadcast" })
    expect((await w.get(settled.address))?.observedFrom).toBe(w.l1.head.toString())
  })

  it("derives a registration event's address from its intent hash on the registration implementation", async () => {
    const w = await pipelineWorld()
    const sipa = await w.announced(1, {
      intentHash: REGISTRATION_HASH,
      implementation: REGISTRATION_IMPL,
    })
    w.pay(sipa.address, ONE)
    w.sweep(sipa, 9n)

    const { claimed } = await w.pass()

    expect(claimed).toMatchObject({ claimed: 1, failed: 0 })
    expect(await w.get(sipa.address)).toMatchObject({
      phase: "claimed",
      intent: "registration",
      claimedInboxIndexes: ["9"],
    })
    expect(await w.records()).toHaveLength(1)
  })

  it("takes a pinned record's missing intent from its event: registration pricing, and backfills it", async () => {
    const w = await pipelineWorld()
    const sipa = await w.announced(3, {
      intentHash: REGISTRATION_HASH,
      implementation: REGISTRATION_IMPL,
    })
    await w.saved(sipa, { phase: "broadcast" })
    w.pay(sipa.address, ONE)
    const intents = pricedIntents(w)

    await w.scan()

    expect(intents).toEqual([2])
    expect(await w.get(sipa.address)).toMatchObject({ intent: "registration" })
  })

  it("prices a registration event's funding probe off the registration row", async () => {
    const w = await pipelineWorld()
    const sipa = await w.announced(1, {
      intentHash: REGISTRATION_HASH,
      implementation: REGISTRATION_IMPL,
    })
    w.pay(sipa.address, ONE)
    const intents = pricedIntents(w)

    await w.scan()

    expect(intents).toEqual([2])
  })

  it("claims an event whose salt matches a local record at the recorded address, not the derived one", async () => {
    const w = await pipelineWorld()
    const derived = await w.announced(3)
    const recorded = { ...derived, address: ELSEWHERE }
    await w.saved(recorded, { phase: "broadcast" })
    w.pay(recorded.address, ONE)
    w.sweep(recorded, 5n)

    const { claimed } = await w.pass()

    expect(claimed).toMatchObject({ claimed: 1, failed: 0 })
    expect(await w.get(ELSEWHERE)).toMatchObject({ phase: "claimed", claimedInboxIndexes: ["5"] })
    expect(await w.get(derived.address)).toBeUndefined()
  })

  it("scans every record sharing a salt: a restarted registration's replacement claims its own sweep", async () => {
    const w = await pipelineWorld()
    const s = salt(3)
    const original = await w.derive(s, {
      intentHash: `0x${"0a".repeat(32)}`,
      implementation: REGISTRATION_IMPL,
    })
    const replacement = await w.derive(s, {
      intentHash: `0x${"0b".repeat(32)}`,
      implementation: REGISTRATION_IMPL,
    })
    for (const sipa of [original, replacement])
      w.l2.emit(L2_TOKEN, RECIPIENT, { salt: s, intentHash: sipa.intentHash })
    const recovery = `0x${"9a".repeat(32)}` as Hex
    await w.saved(replacement, { phase: "broadcast", intent: "registration", startTime: 2 })
    await w.saved(original, {
      phase: "recovered",
      intent: "registration",
      recoveryTxHash: recovery,
      startTime: 1,
      endTime: 1,
    })
    w.pay(replacement.address, ONE)
    w.sweep(replacement, 8n)

    const { claimed } = await w.pass()

    expect(claimed).toMatchObject({ claimed: 1, failed: 0 })
    expect(await w.records()).toHaveLength(2)
    expect(await w.get(replacement.address)).toMatchObject({
      phase: "claimed",
      claimedInboxIndexes: ["8"],
    })
    expect(await w.get(original.address)).toMatchObject({
      phase: "recovered",
      recoveryTxHash: recovery,
    })
  })

  it("scans two unsettled records sharing a salt when neither has an event, in one observation", async () => {
    const w = await pipelineWorld()
    const base = await w.derive(salt(2))
    const [b, c] = [
      { ...base, address: "0x00000000000000000000000000000000000000b2" as Address },
      { ...base, address: "0x00000000000000000000000000000000000000c3" as Address },
    ]
    for (const sipa of [b, c]) await w.saved(sipa, { phase: "broadcast" })
    w.pay(c.address, ONE)
    w.sweep(c, 9n)

    const { claimed } = await w.pass()

    expect(claimed).toMatchObject({ claimed: 1, failed: 0 })
    expect(await w.get(c.address)).toMatchObject({ phase: "claimed" })
    // One observation: one window's reads, whatever the address count.
    expect(w.l1.count({ method: "eth_getLogs" })).toBe(3)
  })
})

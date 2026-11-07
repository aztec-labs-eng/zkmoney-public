// @vitest-environment node
/**
 * Direct deposits: an upgrade's migration executor deposits straight into the portal under a
 * commitment, with no SIPA. And passes over two recipients of one key, each on its own cursor.
 */
import { describe, expect, it } from "vitest"
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import type { Address } from "viem"
import { directAnnouncementIntentHash } from "@obsidion/sdk"
import {
  directDepositKey,
  sipaCursorKey,
  sipaSweepsReceived,
} from "../../../src/engine/sipaDeposits"
import {
  DAI,
  PORTAL,
  pipelineWorld,
  RECIPIENT,
  SAVINGS_L2_TOKEN,
  SAVINGS_PORTAL,
  SAVINGS_ROW,
  DAI_ROW,
  salt,
  SUSDS,
  type PipelineWorld,
} from "./world"

const ONE = 10n ** 18n
const EXECUTOR = "0x00000000000000000000000000000000000000c3" as Address
const OTHER = AztecAddress.fromBigIntUnsafe(0x9999n)

/** The record a batch's sending browser writes before its deposit lands. */
async function batch(w: PipelineWorld, expected?: bigint) {
  const sipa = await w.derive(salt(1))
  const key = directDepositKey(sipa.commitment)
  await w.saved(
    { ...sipa, address: key },
    {
      phase: "broadcast",
      fee: "0",
      direct: {
        recipientCommitment: sipa.commitment,
        executor: EXECUTOR,
        ...(expected === undefined ? {} : { expected: expected.toString() }),
      },
      observedFrom: (w.l1.head - 5_000n).toString(),
      rescanFrom: (w.l1.head - 5_000n).toString(),
    },
  )
  await w.db.write(async (tx) =>
    tx.put(sipaCursorKey(PORTAL, RECIPIENT.toString()), String(w.l1.head - 10n)),
  )
  return { ...sipa, key }
}

/** The event a direct deposit's sender announces it with. */
async function announce(w: PipelineWorld, l2Token?: string) {
  const sipa = await w.derive(salt(1))
  w.l2.emit(l2Token ?? DAI_ROW.l2Token, RECIPIENT, {
    salt: sipa.salt,
    intentHash: directAnnouncementIntentHash(sipa.commitment),
  })
  return { ...sipa, key: directDepositKey(sipa.commitment) }
}

describe("a direct migration deposit", () => {
  it("is read with every SIPA from its batch's block, by its commitment alone, at no other L1 read", async () => {
    const w = await pipelineWorld()
    const { key } = await batch(w, ONE)

    await w.scan()

    expect(w.l1.calls.filter((c) => c.range).map((c) => c.range![0])).toEqual([w.l1.head - 5_000n])
    expect(w.l1.count({ fn: "aggregate3" })).toBe(0)
    expect(w.l1.count({ fn: "rowFor" })).toBe(0)
    expect(w.l1.count({ method: "eth_getBalance" })).toBe(0)
    const record = (await w.get(key))!
    expect(record).toMatchObject({ phase: "broadcast", amount: "0" })
    expect(record.rescanFrom).toBeUndefined()
  })

  it("takes its seen deposit's claim inputs, then claims it like a sweep and reads it no more", async () => {
    const w = await pipelineWorld()
    const { key, commitment } = await batch(w, ONE)
    const deposit = w.l1.directDeposit({
      portal: PORTAL,
      commitment,
      credit: ONE,
      index: 7n,
      block: w.l1.head - 4_000n,
    })

    await w.scan()
    expect(await w.get(key)).toMatchObject({
      phase: "pendingClaim",
      inboxIndex: "7",
      sweepTxHash: deposit.tx,
      netAmount: ONE.toString(),
      fee: "0",
      pendingSweeps: [expect.objectContaining({ inboxIndex: "7", messageKey: deposit.key })],
    })
    w.l2.settle(deposit.key)
    expect(await w.claim()).toMatchObject({ claimed: 1, failed: 0 })
    expect(w.l2.claims[0]).toMatchObject({ inboxIndex: 7n, amount: ONE, salt: salt(1).toString() })
    const record = (await w.get(key))!
    expect(record).toMatchObject({ phase: "claimed", claimedInboxIndexes: ["7"], fee: "0" })
    expect(sipaSweepsReceived(record)).toBe(true)

    w.l1.head += 10n
    const reads = w.l1.count({ method: "eth_getLogs" })
    await w.scan()
    expect(w.l1.count({ method: "eth_getLogs" })).toBe(reads)
  })

  it("keeps reading the commitment after a smaller deposit from another sender, until the batch's amount is claimed", async () => {
    const w = await pipelineWorld()
    const { key, commitment } = await batch(w, ONE)
    w.l1.directDeposit({
      portal: PORTAL,
      commitment,
      credit: 1n,
      index: 6n,
      block: w.l1.head - 4_001n,
    })
    await w.pass()
    expect(await w.get(key)).toMatchObject({ phase: "claimed", claimedInboxIndexes: ["6"] })

    w.l1.head += 10n
    const deposit = w.l1.directDeposit({ portal: PORTAL, commitment, credit: ONE, index: 7n })
    w.l2.settle(deposit.key)
    await w.pass()
    expect(w.l2.claims).toHaveLength(2)
    expect(await w.get(key)).toMatchObject({ claimedInboxIndexes: ["6", "7"] })

    w.l1.head += 10n
    const reads = w.l1.count({ method: "eth_getLogs" })
    await w.scan()
    expect(w.l1.count({ method: "eth_getLogs" })).toBe(reads)
  })

  it("keeps reading a claimed record with no batch amount: another sender can come first", async () => {
    const w = await pipelineWorld()
    const { key } = await batch(w)
    await w.store.apply(key, {
      type: "claimed",
      sweep: { inboxIndex: "7", sweepTxHash: `0x${"5e".repeat(32)}`, netAmount: "990000" },
    })

    await w.scan()

    expect(w.l1.count({ method: "eth_getLogs" })).toBe(1)
  })
})

describe("a commitment shared by a tracked SIPA and a direct record", () => {
  it("claims each deposit on the record that sent it", async () => {
    const w = await pipelineWorld()
    const sipa = await w.derive(salt(1))
    const key = directDepositKey(sipa.commitment)
    await w.saved(sipa, { phase: "broadcast" })
    await w.saved(
      { ...sipa, address: key },
      { phase: "broadcast", direct: { recipientCommitment: sipa.commitment, portal: PORTAL } },
    )
    // The SIPA's sweep sends tokens in its own transaction; the direct deposit sends none.
    w.pay(sipa.address, ONE)
    w.sweep(sipa, 7n)
    w.l1.directDeposit({ portal: PORTAL, commitment: sipa.commitment, credit: ONE, index: 8n })

    const { claimed } = await w.pass()

    expect(claimed).toMatchObject({ claimed: 2, failed: 0 })
    expect(w.l2.claims.map((c) => c.inboxIndex).sort()).toEqual([7n, 8n])
    expect(await w.get(sipa.address)).toMatchObject({
      phase: "claimed",
      claimedInboxIndexes: ["7"],
    })
    expect(await w.get(key)).toMatchObject({ phase: "claimed", claimedInboxIndexes: ["8"] })
  })
})

describe("a direct deposit's announcement", () => {
  it("gives a browser with no batch records the direct deposit's record, and derives no SIPA", async () => {
    const w = await pipelineWorld()
    const { key, commitment } = await announce(w)

    await w.scan()

    expect(await w.records()).toHaveLength(1)
    const record = (await w.get(key))!
    expect(record).toMatchObject({
      phase: "broadcast",
      messageSecret: salt(1).toString(),
      recipientHash: commitment.toLowerCase(),
      recipientL2Address: RECIPIENT.toString(),
      direct: { recipientCommitment: commitment.toLowerCase() },
      fee: "0",
      amount: "0",
    })
    // The same pass read it with every SIPA, by its commitment alone.
    expect(record.observedFrom).toBeDefined()
    expect(w.l1.count({ method: "eth_getLogs" })).toBe(1)
  })

  it("records the deposit on the row of the token that announced it", async () => {
    const w = await pipelineWorld([DAI_ROW, SAVINGS_ROW])
    const { key, commitment } = await announce(w, SAVINGS_L2_TOKEN)

    await w.scan()

    expect(await w.get(key)).toMatchObject({
      tokenAddress: SUSDS,
      tokenSymbol: "sUSDS",
      tokenDecimals: 18,
      direct: { recipientCommitment: commitment.toLowerCase(), portal: SAVINGS_PORTAL },
    })
  })

  it("leaves the pass incomplete when the direct deposit's record does not land", async () => {
    const w = await pipelineWorld()
    const { key } = await announce(w)
    const write = w.db.write
    w.db.write = async () => {
      throw new Error("quota exceeded")
    }

    expect(await w.scan()).toMatchObject({ complete: false })
    w.db.write = write
    expect(await w.get(key)).toBeUndefined()
  })

  it("keeps the sending browser's own record and writes no other", async () => {
    const w = await pipelineWorld()
    const { key } = await batch(w)
    await announce(w)

    await w.scan()

    expect(await w.records()).toHaveLength(1)
    const record = (await w.get(key))!
    expect(record).toMatchObject({ direct: expect.objectContaining({ executor: EXECUTOR }) })
    expect(record.replayed).toBeUndefined()
  })

  it("dates a replayed direct deposit by its deposit's block, not by when this browser found it", async () => {
    const w = await pipelineWorld()
    const { key, commitment } = await announce(w)
    const block = w.l1.head - 400n
    w.l1.directDeposit({ portal: PORTAL, commitment, credit: ONE, index: 7n, block })

    await w.pass()

    const at = Number(w.l1.timeOf(block)) * 1000
    expect(await w.get(key)).toMatchObject({ phase: "claimed", startTime: at, endTime: at })
  })

  it("still reads an ordinary deposit event under the same commitment as a SIPA", async () => {
    const w = await pipelineWorld()
    const sipa = await w.announced(1)

    await w.scan()

    expect(await w.get(directDepositKey(sipa.commitment))).toBeUndefined()
    const record = (await w.get(sipa.address))!
    expect(record).toMatchObject({ recipientHash: sipa.commitment })
    expect(record.direct).toBeUndefined()
  })
})

describe("passes over two recipients of one key", () => {
  it.each([
    ["the two-key pass first", true],
    ["the one-key pass first", false],
  ])(
    "reads each recipient's SIPAs from that recipient's own cursor, %s",
    async (_, twoKeyFirst) => {
      const w = await pipelineWorld()
      const mine = await w.derive(salt(1))
      const theirs = await w.derive(salt(2), { recipient: OTHER })
      const observedFrom = (w.l1.head - 5_000n).toString()
      await w.saved(mine, { phase: "broadcast", observedFrom })
      await w.saved(theirs, { phase: "broadcast", observedFrom })
      await w.db.write(async (tx) => {
        tx.put(sipaCursorKey(PORTAL, RECIPIENT.toString()), String(w.l1.head - 10n))
        tx.put(sipaCursorKey(PORTAL, OTHER.toString()), String(w.l1.head - 1_000n))
      })
      // A sweep of the one-key SIPA inside the gap between the two cursors.
      w.pay(theirs.address, ONE, DAI, w.l1.head - 510n)
      w.sweep(theirs, 7n, { block: w.l1.head - 500n })
      const passes = [{}, { recipient: OTHER }]

      for (const recipient of twoKeyFirst ? passes : passes.reverse())
        expect((await w.pass({ scan: recipient, claim: recipient })).scanned.failed).toBe(0)

      expect(w.l2.claims).toHaveLength(1)
      expect(await w.get(theirs.address)).toMatchObject({
        phase: "claimed",
        claimedInboxIndexes: ["7"],
      })
      expect(await w.cursor(PORTAL, RECIPIENT)).toBe(w.l1.head)
      expect(await w.cursor(PORTAL, OTHER)).toBe(w.l1.head)
    },
  )

  it.each([
    ["the recorded recipient first", true],
    ["the other recipient first", false],
  ])("plans each recipient's own address for a salt both use, %s", async (_, recordedFirst) => {
    const w = await pipelineWorld()
    const mine = await w.announced(1)
    const theirs = await w.announced(1, { recipient: OTHER })
    await w.saved(mine, { phase: "broadcast" })
    const passes = [{}, { recipient: OTHER }]

    for (const recipient of recordedFirst ? passes : passes.reverse())
      expect(await w.scan(recipient)).toMatchObject({ failed: 0 })

    expect(await w.records()).toHaveLength(2)
    expect(await w.get(mine.address)).toMatchObject({
      recipientL2Address: RECIPIENT.toString(),
      recipientHash: mine.commitment,
    })
    expect(await w.get(theirs.address)).toMatchObject({
      recipientL2Address: OTHER.toString(),
      recipientHash: theirs.commitment,
      replayed: true,
    })
  })

  it("claims each recipient's own sweeps, a late one to the one-key address as the one-key account", async () => {
    const w = await pipelineWorld()
    const mine = await w.announced(1)
    const theirs = await w.announced(2, { recipient: OTHER })
    for (const [sipa, index] of [
      [mine, 7n],
      [theirs, 8n],
    ] as const) {
      w.pay(sipa.address, ONE)
      w.sweep(sipa, index)
    }
    const both = async () => {
      await w.pass()
      await w.pass({ scan: { recipient: OTHER }, claim: { recipient: OTHER } })
    }

    await both()
    expect(await w.get(mine.address)).toMatchObject({
      recipientL2Address: RECIPIENT.toString(),
      claimedInboxIndexes: ["7"],
    })
    expect(await w.get(theirs.address)).toMatchObject({
      recipientL2Address: OTHER.toString(),
      claimedInboxIndexes: ["8"],
    })

    w.l1.head += 10n
    w.pay(theirs.address, ONE)
    w.sweep(theirs, 9n)
    await both()
    expect(w.l2.claims.map((c) => c.inboxIndex)).toEqual([7n, 8n, 9n])
    expect(await w.get(theirs.address)).toMatchObject({ claimedInboxIndexes: ["8", "9"] })
  })
})

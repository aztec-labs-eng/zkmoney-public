// @vitest-environment node
/** `complete`: a pass that read everything it should, which is what replays the account's deposits. */
import { describe, expect, it, vi } from "vitest"
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import type { Address, Hex } from "viem"
import { sipaCursorKey } from "../../../src/engine/sipaDeposits"
import {
  DAI,
  FACTORY,
  FEE,
  pipelineWorld,
  PORTAL,
  RECIPIENT,
  REGISTRATION_IMPL,
  salt,
  type PipelineWorld,
} from "./world"

const ONE = 10n ** 18n
const HOUR = 3_600_000
const STRAY_CLONE = "0x00000000000000000000000000000000000000c5" as Address
const OTHER = AztecAddress.fromBigIntUnsafe(0x9999n)

const setCursor = (w: PipelineWorld, block: bigint) =>
  w.db.write(async (tx) => tx.put(sipaCursorKey(PORTAL, RECIPIENT.toString()), String(block)))

/** One announced address, paid and swept. */
async function swept(w: PipelineWorld) {
  const sipa = await w.announced(1)
  w.pay(sipa.address, ONE)
  w.sweep(sipa, 7n)
  return sipa
}

/** A deposit to `sipa`'s commitment from a clone no plan tracks. */
function stray(w: PipelineWorld, sipa: { commitment: Hex }) {
  w.pay(STRAY_CLONE, ONE)
  w.l1.sweep({
    sipa: STRAY_CLONE,
    token: DAI,
    gross: ONE,
    credit: ONE - FEE,
    index: 3n,
    commitment: sipa.commitment,
    portal: PORTAL,
  })
}

describe("complete", () => {
  it("is set by a pass that claims cleanly, and by one with nothing to read", async () => {
    const w = await pipelineWorld()
    await swept(w)
    const { scanned, claimed } = await w.pass()
    expect(scanned.complete).toBe(true)
    expect(claimed).toMatchObject({ claimed: 1, complete: true })

    const empty = await pipelineWorld()
    expect(await empty.scan()).toMatchObject({ complete: true })
    expect(await empty.claim()).toMatchObject({ complete: true })
  })

  it("is cleared by a history start that fails to read, though the cursor was already set and moves", async () => {
    const w = await pipelineWorld()
    await setCursor(w, w.l1.head - 10n)
    await w.announced(1)

    const result = await w.scan({
      historyStartBlock: async () => {
        throw new Error("rpc down")
      },
    })

    expect(result).toMatchObject({ failed: 0, complete: false })
    expect(await w.cursor()).toBe(w.l1.head)
  })

  it.each([
    ["adopting", true],
    ["failing to adopt", false],
  ])("is cleared by %s a stray", async (_, adopted) => {
    const w = await pipelineWorld()
    stray(w, await w.announced(1))
    w.l1.intentOf.set(STRAY_CLONE.toLowerCase(), 1)
    if (!adopted) w.l1.failing = (c) => c.method === "eth_getTransactionReceipt"

    expect(await w.scan()).toMatchObject({ failed: 0, complete: false })
    expect(!!(await w.get(STRAY_CLONE))).toBe(adopted)
  })

  it("is cleared on the claim side by a sweep that fails", async () => {
    const w = await pipelineWorld()
    await swept(w)
    w.l2.claimError = () => new Error("pxe busy")
    expect((await w.pass()).claimed).toMatchObject({ failed: 1, complete: false })
  })

  it("is cleared when the pass does not save, and the cursor holds", async () => {
    const w = await pipelineWorld()
    await swept(w)
    const write = w.db.write
    w.db.write = async () => {
      throw new Error("quota exceeded")
    }
    expect(await w.scan()).toMatchObject({ complete: false })
    w.db.write = write
    expect(await w.cursor()).toBeUndefined()
  })

  it("is cleared when the republish of a paid-again address throws", async () => {
    const w = await pipelineWorld()
    await setCursor(w, w.l1.head - 1n)
    const sipa = await w.announced(1, { resweepable: true })
    await w.saved(sipa, {
      phase: "claimed",
      inboxIndex: "7",
      claimedInboxIndexes: ["7"],
      fee: FEE.toString(),
      endTime: 1,
      observedFrom: (w.l1.head - 1_000n).toString(),
    })
    w.l1.setBalance(sipa.address, DAI, ONE)
    const onSweptAddressFunded = vi.fn(async () => {
      throw new Error("node down")
    })

    expect(await w.scan({ onSweptAddressFunded })).toMatchObject({ failed: 0, complete: false })
    expect(onSweptAddressFunded).toHaveBeenCalledWith(sipa.address)
    expect(await w.get(sipa.address)).toMatchObject({ phase: "claimed" })
  })

  it("is cleared when the republish of an overdue address throws", async () => {
    const w = await pipelineWorld()
    await setCursor(w, w.l1.head - 1n)
    const sipa = await w.announced(1)
    await w.saved(sipa, {
      phase: "sweeping",
      startTime: Date.now() - 2 * HOUR,
      observedFrom: (w.l1.head - 1_000n).toString(),
    })
    w.l1.setBalance(sipa.address, DAI, ONE)
    const onSweepOverdue = vi.fn(async (): Promise<boolean> => {
      throw new Error("node down")
    })

    expect(await w.scan({ onSweepOverdue })).toMatchObject({ failed: 0, complete: false })
    expect(onSweepOverdue).toHaveBeenCalledWith(sipa.address)
  })

  it("is cleared by a funded address whose sweep it cannot price", async () => {
    const w = await pipelineWorld()
    w.pay((await w.announced(1)).address, ONE)
    w.l1.failing = (c) => c.fn === "rowFor"
    expect(await w.scan()).toMatchObject({ failed: 0, complete: false })
  })

  it("is cleared by a swept deposit whose fee it cannot read, which still claims", async () => {
    const w = await pipelineWorld()
    await swept(w)
    w.l1.failing = (c) => c.fn === "rowFor"
    const { scanned, claimed } = await w.pass()
    expect(scanned).toMatchObject({ failed: 0, complete: false })
    expect(claimed).toMatchObject({ claimed: 1, failed: 0 })
  })

  it("is cleared when the blessed user-op list cannot be read", async () => {
    const w = await pipelineWorld()
    await w.announced(1, { intentHash: `0x${"88".repeat(32)}`, implementation: REGISTRATION_IMPL })
    w.l1.failing = (c) =>
      c.method === "eth_getLogs" &&
      String((c.params as { address?: string }[])[0]?.address).toLowerCase() ===
        FACTORY.toLowerCase()
    expect(await w.scan()).toMatchObject({ failed: 0, complete: false })
  })

  it("is cleared when funding attribution fails", async () => {
    const w = await pipelineWorld()
    await swept(w)
    const { scanned, claimed } = await w.pass({
      scan: {
        onFundingWalletDetected: async () => {
          throw new Error("contacts down")
        },
      },
    })
    expect(scanned).toMatchObject({ failed: 0, complete: false })
    expect(claimed.claimed).toBe(1)
  })

  it("is cleared on the claim side when the balance refresh fails", async () => {
    const w = await pipelineWorld()
    await swept(w)
    const { claimed } = await w.pass({
      claim: {
        refreshBalance: async () => {
          throw new Error("node down")
        },
      },
    })
    expect(claimed).toMatchObject({ claimed: 1, failed: 0, complete: false })
  })
})

describe("a stray over two recipients of one key", () => {
  it.each([
    ["the recorded recipient first", true],
    ["the other recipient first", false],
  ])("is adopted under the recipient whose plan it matched, %s", async (_, recordedFirst) => {
    const w = await pipelineWorld()
    const mine = await w.announced(1)
    await w.saved(mine, { phase: "broadcast" })
    const theirs = await w.announced(1, { recipient: OTHER })
    stray(w, theirs)
    w.l1.intentOf.set(STRAY_CLONE.toLowerCase(), 1)
    const passes = [{}, { recipient: OTHER }]

    for (const recipient of recordedFirst ? passes : passes.reverse())
      expect(await w.scan(recipient)).toMatchObject({ failed: 0 })

    expect(w.l1.count({ method: "eth_getTransactionReceipt" })).toBe(1)
    expect(await w.get(STRAY_CLONE)).toMatchObject({
      recipientL2Address: OTHER.toString(),
      messageSecret: salt(1).toString(),
      recipientHash: theirs.commitment,
      replayed: true,
    })
    expect(await w.get(mine.address)).toMatchObject({ recipientL2Address: RECIPIENT.toString() })
    expect(await w.get(theirs.address)).toMatchObject({ recipientL2Address: OTHER.toString() })
  })
})

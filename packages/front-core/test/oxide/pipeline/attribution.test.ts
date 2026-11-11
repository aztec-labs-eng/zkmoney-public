// @vitest-environment node
/** Who funded an address, how a pass derives it, and a second payment to a claimed one. */
import { describe, expect, it, vi } from "vitest"
import { getAddress, type Address } from "viem"
import type { OxideEnvTuple } from "@obsidion/core/types"
import { isStuckSweep, STUCK_SWEEP_MS } from "../../../src/core/services/deposits/sipaStuck"
import { DAI, FEE, FUNDER, pipelineWorld, PORTAL, salt, TABLE, TUPLE, USDC } from "./world"

const ONE = 10n ** 18n
const SESSION_WALLET = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
const FORGER = "0x00000000000000000000000000000000000000ff" as Address

describe("funding attribution", () => {
  it("stamps the funder and funding tx, backfills the wallet address, and fires the hook with the bare address", async () => {
    const w = await pipelineWorld()
    const sipa = await w.announced(1)
    const tx = w.pay(sipa.address, ONE)
    const onFundingWalletDetected = vi.fn(async () => undefined)

    await w.scan({ onFundingWalletDetected })

    expect(await w.get(sipa.address)).toMatchObject({
      fundingTxHash: tx,
      fundingFromAddress: getAddress(FUNDER),
      walletAddress: getAddress(FUNDER),
    })
    // A third-party deposit: no session identity to pass through.
    expect(onFundingWalletDetected).toHaveBeenCalledOnce()
    expect(onFundingWalletDetected).toHaveBeenCalledWith(
      expect.objectContaining({ address: getAddress(FUNDER), walletName: undefined }),
    )
  })

  it("dates a deposit this device handed out by its funding transfer's block", async () => {
    const w = await pipelineWorld()
    const sipa = await w.announced(1)
    await w.saved(sipa, { phase: "broadcast", startTime: 1 })
    const block = w.l1.head - 70n
    w.pay(sipa.address, ONE, DAI, block)

    await w.scan()

    expect(await w.get(sipa.address)).toMatchObject({
      startTime: Number(w.l1.timeOf(block)) * 1000,
    })
  })

  it("never reads transfers into an attributed address", async () => {
    const w = await pipelineWorld()
    const sipa = await w.announced(1)
    await w.saved(sipa, {
      phase: "sweeping",
      fundingFromAddress: FUNDER,
      fundingTxHash: `0x${"cd".repeat(32)}`,
    })

    await w.scan()

    // Deposits and outflows only.
    expect(w.l1.count({ method: "eth_getLogs" })).toBe(2)
  })

  it("keeps the connected-session identity when the on-chain funder differs, and passes it when matching", async () => {
    const w = await pipelineWorld()
    const [a, b] = [await w.announced(1), await w.announced(2)]
    const identity = { walletName: "Rainbow" }
    await w.saved(a, { phase: "funded", walletAddress: SESSION_WALLET, ...identity })
    await w.saved(b, {
      phase: "funded",
      walletAddress: FUNDER.toUpperCase().replace("0X", "0x"),
      ...identity,
    })
    w.pay(a.address, ONE)
    w.pay(b.address, ONE)
    const onFundingWalletDetected = vi.fn(async () => undefined)

    await w.scan({ onFundingWalletDetected })

    // Divergence: both kept, the session identity not overwritten.
    expect(await w.get(a.address)).toMatchObject({
      walletAddress: SESSION_WALLET,
      fundingFromAddress: getAddress(FUNDER),
    })
    expect(
      (onFundingWalletDetected.mock.calls as unknown as [{ walletName?: string }][])
        .map(([d]) => d.walletName)
        .sort(),
    ).toEqual(["Rainbow", undefined].sort())
  })

  it("isolates attribution failures from the claim path", async () => {
    const w = await pipelineWorld()
    const sipa = await w.announced(1)
    w.pay(sipa.address, ONE)
    w.sweep(sipa, 7n)

    const { claimed } = await w.pass({
      scan: {
        onFundingWalletDetected: async () => {
          throw new Error("contacts down")
        },
      },
    })

    expect(claimed).toMatchObject({ claimed: 1, failed: 0 })
    expect(await w.get(sipa.address)).toMatchObject({ phase: "claimed" })
  })

  it("reads deposits, outflows and fundings at once, not one after another", async () => {
    const w = await pipelineWorld()
    const sipa = await w.announced(1)
    w.pay(sipa.address, ONE)
    w.sweep(sipa, 7n)
    let arrived = 0
    let release = () => {}
    const all = new Promise<void>((resolve) => (release = resolve))
    w.l1.before = async (call) => {
      if (call.method !== "eth_getLogs") return
      if (++arrived === 3) release()
      await all
    }

    const { claimed } = await w.pass()

    expect(claimed).toMatchObject({ claimed: 1, failed: 0 })
    expect(await w.get(sipa.address)).toMatchObject({
      phase: "claimed",
      fundingFromAddress: getAddress(FUNDER),
    })
  })

  it("stamps the earliest funding across every accepted token", async () => {
    const w = await pipelineWorld()
    const sipa = await w.announced(1)
    w.pay(sipa.address, 1n, DAI, w.l1.head - 50n)
    const usdc = w.pay(sipa.address, 5_000_000n, USDC, w.l1.head - 60n)

    await w.scan()

    expect(await w.get(sipa.address)).toMatchObject({
      fundingTxHash: usdc,
      tokenAddress: USDC,
      tokenSymbol: "USDC",
    })
  })

  it("breaks a tie on block number with the first listed token", async () => {
    const w = await pipelineWorld()
    const sipa = await w.announced(1)
    const block = w.l1.head - 50n
    w.pay(sipa.address, 5_000_000n, USDC, block)
    const dai = w.pay(sipa.address, ONE, DAI, block)

    await w.scan()

    expect(await w.get(sipa.address)).toMatchObject({
      fundingTxHash: dai,
      tokenAddress: DAI,
      tokenSymbol: "DAI",
    })
  })
})

describe("derivation", () => {
  it("derives a SIPA under the deployment's table and records the table on its origin", async () => {
    const w = await pipelineWorld()
    const sipa = await w.announced(1)

    await w.scan()

    expect((await w.get(sipa.address))?.origin).toMatchObject({
      protocol: "account",
      forwardingTable: TABLE,
    })
  })

  it("refuses discovery on a deployment that names no table", async () => {
    const w = await pipelineWorld()
    await w.announced(1)
    const tuple = { ...TUPLE, forwardingTable: undefined } as unknown as OxideEnvTuple

    expect(await w.scan({ tuple })).toMatchObject({ failed: 1, discovered: 0 })
    expect(await w.records()).toEqual([])
  })

  it("reads the factory's deposit pointer on every pass, and again after a failed read", async () => {
    const w = await pipelineWorld()
    await w.announced(1)
    let failures = 1
    w.l1.failing = (c) => c.fn === "implementationFor" && failures-- > 0

    await expect(w.scan()).rejects.toThrow()
    await expect(w.scan()).resolves.toMatchObject({ discovered: 1 })
    await w.scan()

    expect(w.l1.count({ fn: "implementationFor" })).toBe(3)
  })
})

describe("a second payment to a claimed address", () => {
  /** Claims one sweep, then reads the same address with new funds and no new sweep. */
  async function payAgain(resweepable: boolean) {
    const w = await pipelineWorld()
    const sipa = await w.announced(1, { resweepable })
    w.pay(sipa.address, ONE, DAI, w.l1.head - 1_010n)
    const first = w.sweep(sipa, 7n, { block: w.l1.head - 1_000n })
    await w.pass()
    expect(await w.get(sipa.address)).toMatchObject({ phase: "claimed", sweepTxHash: first.tx })
    w.l1.head += 10n
    w.l1.setBalance(sipa.address, DAI, ONE / 2n)
    await w.scan()
    return { w, sipa, first }
  }

  it("reopens a resweepable address on a fresh stuck clock, owing its broadcast once", async () => {
    const before = Date.now()
    const { w, sipa } = await payAgain(true)

    const record = (await w.get(sipa.address))!
    expect(record).toMatchObject({ phase: "sweeping", amount: "0.5", claimedInboxIndexes: ["7"] })
    expect(record.sweepTxHash).toBeUndefined()
    expect(record.netAmount).toBeUndefined()
    expect(record.startTime).toBeGreaterThanOrEqual(before)
    expect(record.broadcast).toMatchObject({ state: "queued", republishSince: w.l2.block })
    await w.store.apply(sipa.address, { type: "broadcastLanded" })
    w.l1.head += 1n
    await w.scan()
    expect((await w.get(sipa.address))?.broadcast?.state).toBe("landed")
  })

  it("owes a payment its transfer dates over an hour back its broadcast once", async () => {
    const w = await pipelineWorld()
    const sipa = await w.announced(1, { resweepable: true })
    w.pay(sipa.address, ONE, DAI, w.l1.head - 1_010n)
    w.sweep(sipa, 7n, { block: w.l1.head - 1_000n })
    await w.pass()
    w.l1.head += 10n
    w.pay(sipa.address, ONE / 2n, DAI, w.l1.head - 5n)

    expect(await w.scan()).toMatchObject({ republished: 1 })
    await w.store.apply(sipa.address, { type: "broadcastLanded" })
    w.l1.head += 1n
    expect(await w.scan()).toMatchObject({ republished: 0 })
    expect((await w.get(sipa.address))?.broadcast?.state).toBe("landed")
  })

  it("keeps the claim until the L2 head reads, then owes the broadcast", async () => {
    const w = await pipelineWorld()
    const sipa = await w.announced(1, { resweepable: true })
    w.pay(sipa.address, ONE, DAI, w.l1.head - 1_010n)
    const first = w.sweep(sipa, 7n, { block: w.l1.head - 1_000n })
    await w.pass()
    w.l1.head += 10n
    w.l1.setBalance(sipa.address, DAI, ONE / 2n)
    w.l2.headError = new Error("node down")

    expect(await w.scan()).toMatchObject({ complete: false })
    const held = await w.get(sipa.address)
    expect(held).toMatchObject({ phase: "claimed", sweepTxHash: first.tx })
    expect(held?.broadcast).toBeUndefined()
    w.l2.headError = undefined
    w.l1.head += 1n
    await w.scan()
    expect(await w.get(sipa.address)).toMatchObject({
      phase: "sweeping",
      broadcast: { state: "queued" },
    })
  })

  it("sends a second payment to an address that refuses a second sweep to recovery", async () => {
    const { w, sipa } = await payAgain(false)

    const record = await w.get(sipa.address)
    expect(record?.phase).toBe("recoverable")
    expect(record?.broadcast).toBeUndefined()
  })

  it("reopens a sweeping record still stamped with its claimed sweep", async () => {
    const w = await pipelineWorld()
    const sipa = await w.announced(1, { resweepable: true })
    await w.saved(sipa, {
      phase: "sweeping",
      startTime: 1,
      endTime: 2,
      inboxIndex: "7",
      claimedInboxIndexes: ["7"],
      sweepTxHash: `0x${"5e".repeat(32)}`,
    })
    w.l1.setBalance(sipa.address, DAI, ONE / 2n)

    await w.scan()

    const record = (await w.get(sipa.address))!
    expect(record.sweepTxHash).toBeUndefined()
    expect(record.endTime).toBeUndefined()
    expect(isStuckSweep(record, record.startTime + STUCK_SWEEP_MS)).toBe(true)
    expect(record.broadcast).toMatchObject({ state: "queued" })
  })
})

describe("SIPAs of one commitment swept in one transaction", () => {
  it("tells SIPAs swept together in one transaction apart by the Sweep log each emits", async () => {
    const w = await pipelineWorld()
    const base = await w.derive(salt(2))
    const [b, c] = [
      { ...base, address: "0x00000000000000000000000000000000000000b2" as Address },
      { ...base, address: "0x00000000000000000000000000000000000000c3" as Address },
    ]
    for (const sipa of [b, c]) {
      await w.saved(sipa, { phase: "broadcast" })
      w.pay(sipa.address, ONE)
    }
    const tx = w.l1.tx()
    // A forged log ahead of each real one does not move a deposit off the sender that emitted one.
    for (const [sipa, index] of [
      [b, 8n],
      [c, 7n],
    ] as const)
      w.l1.sweep({
        sipa: sipa.address,
        token: DAI,
        gross: ONE,
        credit: ONE - FEE,
        index,
        commitment: sipa.commitment,
        portal: PORTAL,
        block: w.l1.head - 40n,
        alsoEmitted: [FORGER],
        tx,
      })

    // Without the logs, neither sender is observed this pass: their window is read again.
    w.l1.failing = (call) => call.method === "eth_getTransactionReceipt"
    expect(await w.scan()).toMatchObject({ complete: false })
    for (const sipa of [b, c])
      expect(await w.get(sipa.address)).toMatchObject({ phase: "broadcast" })
    w.l1.failing = () => false

    expect((await w.pass()).claimed).toMatchObject({ claimed: 2, failed: 0 })
    expect(await w.get(b.address)).toMatchObject({ claimedInboxIndexes: ["8"], sweepTxHash: tx })
    expect(await w.get(c.address)).toMatchObject({ claimedInboxIndexes: ["7"], sweepTxHash: tx })
  })
})

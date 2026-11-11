// @vitest-environment node
/** Addresses the resolver handed out: recorded by the scan that sees them funded. */
import { describe, expect, it } from "vitest"
import { secp256k1 } from "@noble/curves/secp256k1"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { zeroAddress, type Address } from "viem"
import { broadcastJobs, nextBroadcast } from "../../../src/engine/sipaBroadcasts"
import { isUnfundedSipaDeposit } from "../../../src/engine/sipaDeposits"
import {
  createResolverWindow,
  RESOLVER_SLOTS,
  type ResolverDeployment,
} from "../../../src/oxide/resolverPayments"
import {
  DAI,
  DEPOSIT_IMPL,
  FACTORY,
  pipelineWorld,
  PORTAL,
  RECIPIENT,
  RECOVERY_ACCOUNT,
  TABLE,
  TUPLE,
  type PipelineWorld,
} from "./world"

const ONE = 10n ** 18n
const RESOLVER = secp256k1.ProjectivePoint.BASE.multiply(0x0a0b0c0dn).toAffine()

const deployment: ResolverDeployment = {
  portal: PORTAL,
  sipaFactory: FACTORY,
  forwardingTable: TABLE,
  implementation: DEPOSIT_IMPL,
  rollupVersion: BigInt(TUPLE.rollupVersion),
  resolverPublicKey: { x: RESOLVER.x, y: RESOLVER.y },
  recoveryAccount: RECOVERY_ACCOUNT,
  accountFactory: TUPLE.accountFactory as Address,
  tokens: [{ address: DAI, symbol: "DAI", decimals: 18 }],
}

/** The resolver's addresses for the chain's day, as the scan task reads them. */
async function candidates(w: PipelineWorld) {
  return createResolverWindow(RESOLVER_SLOTS)(
    { stealthScalar: w.stealth.scalar, selfSipaKey: new Fr(9n), recipient: RECIPIENT },
    [deployment],
    await w.records(),
    Number(w.l1.timeOf(w.l1.head)) * 1000,
  )
}

describe("resolver payments", () => {
  it("records a funded address as an incoming deposit on the pass that sees it, in the same balance read", async () => {
    const w = await pipelineWorld()
    // One day's addresses fit one Multicall3 chunk: the count shows they add no read of their own.
    const all = await candidates(w)
    const window = all.filter((c) => c.day === all[0]!.day)
    const paid = window[10]!
    w.l1.setBalance(paid.sipaAddress, DAI, 25n * ONE)

    const result = await w.scan({ resolverCandidates: window })

    expect(result.resolverFunded).toBe(1)
    expect(w.l1.count({ fn: "aggregate3" })).toBe(1)
    expect(await w.records()).toHaveLength(1)
    const record = (await w.get(paid.sipaAddress))!
    expect(record).toMatchObject({
      phase: "sweeping",
      amount: "25",
      tokenAddress: DAI,
      tokenSymbol: "DAI",
      recipientL2Address: RECIPIENT.toString(),
      messageSecret: paid.messageSecret,
      recipientHash: paid.recipientHash,
      origin: paid.origin,
    })
    expect(isUnfundedSipaDeposit(record)).toBe(false)
  })

  it("records the asset that arrived: ETH on any deployment", async () => {
    const w = await pipelineWorld()
    const window = await candidates(w)
    w.l1.setBalance(window[3]!.sipaAddress, zeroAddress, ONE / 10n)

    await w.scan({ resolverCandidates: window })

    const record = (await w.get(window[3]!.sipaAddress))!
    expect(record).toMatchObject({ amount: "0.1", tokenAddress: zeroAddress, tokenSymbol: "ETH" })
    // No sweep moves ETH: nothing to publish.
    expect(record.broadcast).toBeUndefined()
  })

  it("owes the broadcast of a payment from days back, ahead of a pool fill", async () => {
    const w = await pipelineWorld()
    const window = await candidates(w)
    const paid = window.find((c) => c.day === window[0]!.day - 10)!
    w.l1.setBalance(paid.sipaAddress, DAI, 25n * ONE)
    await w.store.oweBroadcast("0x2222222222222222222222222222222222222222", {
      kind: "pool",
      source: { type: "slot" },
    })

    await w.scan({ resolverCandidates: window })

    expect((await w.get(paid.sipaAddress))!.broadcast).toMatchObject({
      kind: "deposit",
      source: { type: "slot" },
      state: "queued",
    })
    const next = nextBroadcast(broadcastJobs(await w.records()), Date.now())
    expect(next?.address).toBe(paid.sipaAddress.toLowerCase())
  })

  it("owes nothing on a pass over another account's history", async () => {
    const w = await pipelineWorld()
    const window = await candidates(w)
    w.l1.setBalance(window[5]!.sipaAddress, DAI, 25n * ONE)

    await w.scan({ resolverCandidates: window, republishes: false })

    expect((await w.get(window[5]!.sipaAddress))!.broadcast).toBeUndefined()
  })

  it("leaves a record that already holds the address", async () => {
    const w = await pipelineWorld()
    const window = await candidates(w)
    const paid = window[2]!
    await w.store.apply(paid.sipaAddress, {
      type: "discovered",
      fields: {
        sipaAddress: paid.sipaAddress,
        phase: "claimed",
        recipientL2Address: RECIPIENT.toString(),
        messageSecret: paid.messageSecret,
        recipientHash: paid.recipientHash,
        recoveryAddress: "",
        l1ChainId: 1,
        networkId: "0x01",
        amount: "25",
        tokenSymbol: "DAI",
        startTime: 1,
        endTime: 1,
      },
    })
    w.l1.setBalance(paid.sipaAddress, DAI, 25n * ONE)

    // The window was read before the record was saved: the pass still opens no second record.
    expect(await w.scan({ resolverCandidates: window })).toMatchObject({ resolverFunded: 0 })
    expect(await w.records()).toHaveLength(1)
  })

  it("is the same record discovery finds when the resolver's event arrives", async () => {
    const w = await pipelineWorld()
    const window = await candidates(w)
    const paid = window[11]!
    w.l1.setBalance(paid.sipaAddress, DAI, 5n * ONE)
    await w.scan({ resolverCandidates: window })
    const event = {
      salt: Fr.fromHexString(paid.messageSecret),
      intentHash: paid.origin.intentHash,
    }
    w.l2.emit(TUPLE.l2Token, RECIPIENT, event)

    w.l1.head += 1n
    await w.scan()

    expect(await w.records()).toHaveLength(1)
    const record = (await w.get(paid.sipaAddress))!
    expect(record).toMatchObject({
      messageSecret: paid.messageSecret,
      origin: { intentHash: paid.origin.intentHash },
    })
    expect(record.replayed).toBeUndefined()
    // Discovery alone, on a device that never read the window, lands on the same address.
    const fresh = await pipelineWorld()
    fresh.l2.emit(TUPLE.l2Token, RECIPIENT, event)
    await fresh.scan()
    expect((await fresh.records()).map((r) => r.sipaAddress.toLowerCase())).toEqual([
      paid.sipaAddress.toLowerCase(),
    ])
    // And the window no longer names it.
    expect((await candidates(w)).map((c) => c.sipaAddress)).not.toContain(paid.sipaAddress)
  })
})

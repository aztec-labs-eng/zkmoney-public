// @vitest-environment node
/**
 * A deposit address the account showed and never published: no event names it, so only the scan's
 * self window finds it funded, on a device that never saw it, within the window's days.
 */
import { describe, expect, it } from "vitest"
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { EthAddress } from "@aztec-labs/foundation/eth-address"
import {
  buildDepositIntent,
  deriveSelfSipaSecret,
  epochDay,
  SELF_BROADCAST_RESWEEPABLE,
  selfSipaNonce,
  SipaSelfResolver,
} from "@obsidion/sdk"
import type { SipaDeposit } from "../../../src/engine/sipaDeposits"
import { deriveSelfSipaKey, selfSipaResolverKeys } from "../../../src/oxide/oxideAccountKeys"
import {
  createResolverWindow,
  findOwnSlot,
  RESOLVER_LOOKBACK_DAYS,
  SELF_SLOTS,
  selfDeployment,
} from "../../../src/oxide/resolverPayments"
import {
  DAI,
  DAI_ROW,
  DEPOSIT_IMPL,
  L2_TOKEN,
  MSK,
  pipelineWorld,
  RECIPIENT,
  RECOVERY_ACCOUNT,
  TUPLE,
  type PipelineWorld,
} from "./world"

const DAY_MS = 86_400_000
const KEY = deriveSelfSipaKey(MSK)

/** The account's own address at `day`'s `slot`, and its broadcast's event, as discovery reads it. */
async function ownSlot(w: PipelineWorld, day: number, slot: number) {
  const sipa = await w.derive(deriveSelfSipaSecret(KEY, day, selfSipaNonce(slot)))
  return { ...sipa, publish: () => w.l2.emit(L2_TOKEN, RECIPIENT, sipa) }
}

const keysOf = (w: PipelineWorld) => ({
  stealthScalar: w.stealth.scalar,
  selfSipaKey: KEY,
  recipient: RECIPIENT,
})

/** A scan with the window the scan task gives it, on chain day `today`. */
function scanOn(w: PipelineWorld, today: number) {
  const window = createResolverWindow(SELF_SLOTS)
  const keys = keysOf(w)
  return w.scan({
    selfCandidates: (deployment, records, salts) =>
      window(keys, [deployment], records, today * DAY_MS, salts),
  })
}

/** Slots 0 to 3 of `day` published; slot 4, past the base window, shown, never published, paid. */
async function lostSlot(w: PipelineWorld, day: number) {
  for (const slot of [0, 1, 2, 3]) (await ownSlot(w, day, slot)).publish()
  const lost = await ownSlot(w, day, 4)
  w.pay(lost.address, 25n * 10n ** 18n)
  return lost
}

describe("the self window", () => {
  const shown = epochDay(Math.floor(Date.now() / 1000)) - 1

  it("records a paid slot no device published, a day later, in the same pass and its reads", async () => {
    const w = await pipelineWorld()
    const lost = await lostSlot(w, shown)
    const plain = await pipelineWorld()
    await lostSlot(plain, shown)
    await plain.scan()

    const result = await scanOn(w, shown + 1)

    expect(result.resolverFunded).toBe(1)
    expect(w.l1.count({})).toBe(plain.l1.count({}))
    expect(w.l1.count({ fn: "aggregate3" })).toBe(1)
    expect(await w.get(lost.address)).toMatchObject({
      messageSecret: lost.salt.toString(),
      recipientHash: lost.commitment,
      amount: "25",
      tokenAddress: DAI,
      slot: { day: shown, nonce: selfSipaNonce(4) },
      broadcast: { kind: "deposit", source: { type: "slot" }, state: "queued" },
    })
    expect((await w.get(lost.address))!.broadcast!.fundedAt).toBeDefined()

    // Its broadcast lands: discovery names the same address, and no second record opens.
    lost.publish()
    w.l1.head += 1n
    await scanOn(w, shown + 1)
    const records = (await w.records()).filter((r) => r.messageSecret === lost.salt.toString())
    expect(records.map((r) => r.sipaAddress.toLowerCase())).toEqual([lost.address.toLowerCase()])
  })

  it(`stops watching a slot once its day is ${RESOLVER_LOOKBACK_DAYS} chain days old`, async () => {
    const w = await pipelineWorld()
    const lost = await lostSlot(w, shown)

    const result = await scanOn(w, shown + RESOLVER_LOOKBACK_DAYS)

    expect(result.resolverFunded).toBe(0)
    expect(await w.get(lost.address)).toBeUndefined()
  })
})

describe("SELF_SLOTS", () => {
  it("derives the address the hand-out's SipaSelfResolver resolves, from the same master secret", async () => {
    const w = await pipelineWorld()
    const deployment = selfDeployment(TUPLE, DEPOSIT_IMPL, RECOVERY_ACCOUNT, [DAI_ROW.token])!
    const day = epochDay(Math.floor(Date.now() / 1000))
    const [candidate] = await createResolverWindow(SELF_SLOTS)(
      keysOf(w),
      [deployment],
      [],
      Date.now(),
    )
    const resolved = await new SipaSelfResolver(selfSipaResolverKeys(MSK)).resolve(
      RECIPIENT,
      day,
      selfSipaNonce(0),
      EthAddress.fromString(RECOVERY_ACCOUNT),
    )
    const { intentHash } = buildDepositIntent({
      implementation: DEPOSIT_IMPL,
      recipientCommitment: resolved.recipientHash.toString() as `0x${string}`,
    })

    expect(candidate).toMatchObject({
      day,
      nonce: selfSipaNonce(0),
      messageSecret: resolved.messageSecret.toString(),
      recipientHash: resolved.recipientHash.toString(),
      origin: {
        intentHash,
        recoveryCommitment: resolved.recoveryCommitment.toString(),
        resweepable: SELF_BROADCAST_RESWEEPABLE,
      },
    })
  })

  it("keeps a slot whose salt another account of the same master secret recorded", async () => {
    const w = await pipelineWorld()
    const deployment = selfDeployment(TUPLE, DEPOSIT_IMPL, RECOVERY_ACCOUNT, [DAI_ROW.token])!
    const previous = AztecAddress.fromStringUnsafe(`0x${"0b".repeat(32)}`)
    const window = createResolverWindow(SELF_SLOTS)
    const now = Date.now()
    const [theirs] = await window({ ...keysOf(w), recipient: previous }, [deployment], [], now)
    const [ours] = await window(keysOf(w), [deployment], [], now)
    const record = {
      sipaAddress: theirs!.sipaAddress,
      messageSecret: theirs!.messageSecret,
      recipientL2Address: previous.toString(),
    } as SipaDeposit

    const candidates = await window(keysOf(w), [deployment], [record], now)

    expect(ours!.messageSecret).toBe(theirs!.messageSecret)
    expect(candidates.map((c) => c.sipaAddress)).toContain(ours!.sipaAddress)
  })
})

describe("the pasted-address search", () => {
  const today = epochDay(Math.floor(Date.now() / 1000))
  const deployment = selfDeployment(TUPLE, DEPOSIT_IMPL, RECOVERY_ACCOUNT, [DAI_ROW.token])!

  it("finds an address shown 60 days ago past that day's recorded and published slots, offline", async () => {
    const w = await pipelineWorld()
    // Slots 0 and 1 have records here; 2 and 3 only events, which this device's PXE holds.
    for (const slot of [0, 1]) await w.saved(await ownSlot(w, today - 60, slot))
    const published = await Promise.all([2, 3].map((slot) => ownSlot(w, today - 60, slot)))
    const salts = new Set(published.map((p) => p.salt.toString()))
    const pasted = await ownSlot(w, today - 60, 6)
    const records = await w.records()
    const search = (fromDay: number, known: ReadonlySet<string> = salts) =>
      findOwnSlot(keysOf(w), deployment, pasted.address, records, known, fromDay, today)

    expect(await search(today - 90)).toMatchObject({
      day: today - 60,
      nonce: selfSipaNonce(6),
      messageSecret: pasted.salt.toString(),
    })
    expect(w.l1.count({})).toBe(0)
    expect(await search(today - 90, new Set())).toBeUndefined()
    expect(await search(today - 59)).toBeUndefined()
  })

  it("finds a slot past the resolver's 60 a day, on a busy day", async () => {
    const w = await pipelineWorld()
    const day = today - 30
    const published = await Promise.all(
      Array.from({ length: 60 }, (_, slot) => ownSlot(w, day, slot)),
    )
    const pasted = await ownSlot(w, day, 61)
    const salts = new Set(published.map((p) => p.salt.toString()))
    const found = await findOwnSlot(keysOf(w), deployment, pasted.address, [], salts, day, day)
    expect(found).toMatchObject({ day, nonce: selfSipaNonce(61) })
  })
})

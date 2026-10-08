// @vitest-environment jsdom
/**
 * The deposit rail learns of a registration's funds and sweep from the wallet, ahead of its own
 * Sweep-log scan, so the deposit flow's surfaces (the bell's live row first) carry the registration
 * from the moment the money lands.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  SIPADepositStore,
  sipaDepositInflightLabel,
  type PendingRegistrationRecord,
} from "@obsidion/front-core"

vi.mock("../src/config/env", () => ({
  getConfig: () => ({ network: "testnet", l1ChainId: 11155111 }),
}))

const { noteRegistrationDepositSeen, syncRegistrationRail, sweptPhase } = await import(
  "../src/features/onboarding/registrationRailSync"
)
const { saveRegistrationTerms } = await import("../src/features/onboarding/registrationTerms")
const { webStorage } = await import("../src/platform/storage/WebStorageAdapter")
const { walletStorage } = await import("../src/platform/storage/walletStorage")

const ACCOUNT = "0x00000000000000000000000000000000000000aa"
const SIPA = "0x00000000000000000000000000000000000000c3"
const HASH = `0x${"5e".repeat(32)}` as const
const DAI = 10n ** 18n

const record = (over: Partial<PendingRegistrationRecord> = {}): PendingRegistrationRecord =>
  ({
    account: ACCOUNT,
    tag: "taga",
    nameHash: `0x${"77".repeat(32)}`,
    l2Address: `0x${"cd".repeat(32)}`,
    l1ChainId: 11155111,
    sipaAddress: SIPA,
    depositToken: "0x00000000000000000000000000000000000000d4",
    broadcast: true,
    phase: "awaiting_deposit",
    retries: 0,
    startTime: Date.now(),
    ...over,
  } as PendingRegistrationRecord)

const rail = () => SIPADepositStore.get(webStorage)
const deposit = () => rail().get(SIPA as never)!

/** The seeder's record: a registration SIPA the scan has not seen funded. */
async function seedRail(over: Record<string, unknown> = {}) {
  await rail().load()
  await rail().upsert(
    SIPA as never,
    { phase: "broadcast" } as never,
    {
      amount: "0",
      startTime: Date.now(),
      tokenSymbol: "DAI",
      tokenDecimals: 18,
      intent: "registration",
      registrationFee: String(DAI / 2n),
      ...over,
    } as never,
  )
}

function resetRail() {
  for (const key of walletStorage.keys()) walletStorage.removeItem(key)
  ;(SIPADepositStore as unknown as { instance: unknown }).instance = null
}

beforeEach(resetRail)

describe("funds seen at the address", () => {
  it("put the deposit on the rail at the amount seen, and the bell's live row with it", async () => {
    await seedRail()
    expect(sipaDepositInflightLabel(deposit())).toBeUndefined()
    await noteRegistrationDepositSeen(SIPA, 15n * DAI)
    expect(deposit()).toMatchObject({ phase: "broadcast", amount: "15" })
    expect(sipaDepositInflightLabel(deposit())).toBe("Receiving")
  })

  it("keep an amount the rail already holds, and write nothing for an empty read", async () => {
    await seedRail()
    await noteRegistrationDepositSeen(SIPA, 0n)
    expect(deposit().amount).toBe("0")
    await noteRegistrationDepositSeen(SIPA, 15n * DAI)
    await noteRegistrationDepositSeen(SIPA, 16n * DAI)
    expect(deposit().amount).toBe("15")
  })

  it("do nothing for an address the rail does not track", async () => {
    await rail().load()
    await noteRegistrationDepositSeen(SIPA, 15n * DAI)
    expect(rail().get(SIPA as never)).toBeNull()
  })
})

describe("the tick's stamps reach the rail", () => {
  it("a funded record puts the amount the address watch stamped on the rail", async () => {
    await seedRail()
    saveRegistrationTerms({
      account: ACCOUNT,
      tag: "taga",
      deadline: 0,
      depositAmount: String(15n * DAI),
    })
    await syncRegistrationRail([record({ fundedAt: Date.now(), phase: "funded" })])
    expect(deposit()).toMatchObject({ phase: "broadcast", amount: "15" })
  })

  it("a funded record with no stamped amount leaves the rail waiting for the watch", async () => {
    await seedRail()
    await syncRegistrationRail([record({ fundedAt: Date.now(), phase: "funded" })])
    expect(sipaDepositInflightLabel(deposit())).toBeUndefined()
  })

  it("a swept record moves the rail to sweeping with the sweep's hash, once", async () => {
    await seedRail({ amount: "15" })
    const swept = record({ fundedAt: 1, sweptAt: 2, sweepTxHash: HASH, phase: "funded" })
    await syncRegistrationRail([swept])
    expect(deposit()).toMatchObject({ phase: "sweeping", sweepTxHash: HASH })
    expect(sipaDepositInflightLabel(deposit())).toBe("Receiving")
    const listener = vi.fn()
    rail().onListChanged(listener)
    await syncRegistrationRail([swept])
    expect(listener).not.toHaveBeenCalled()
  })

  it("never moves a rail record the scan has carried past the sweep", async () => {
    await seedRail({ amount: "15" })
    await rail().upsert(SIPA as never, { phase: "pendingClaim" } as never)
    await syncRegistrationRail([record({ sweptAt: 2, sweepTxHash: HASH, phase: "funded" })])
    expect(deposit().phase).toBe("pendingClaim")
    for (const phase of ["resolved", "funding", "funded", "broadcast"] as const) {
      expect(sweptPhase(phase)).toBe("sweeping")
    }
    expect(sweptPhase("claimed")).toBe("claimed")
  })
})

// The address watch, the tick and the rail's own scan report on the same deposit independently.
describe("observations that land together", () => {
  const swept = () => record({ fundedAt: 1, sweptAt: 2, sweepTxHash: HASH, phase: "funded" })

  it("keep the sweep whichever lands first", async () => {
    await seedRail()
    await Promise.all([
      syncRegistrationRail([swept()]),
      noteRegistrationDepositSeen(SIPA, 15n * DAI),
    ])
    expect(deposit()).toMatchObject({ phase: "sweeping", sweepTxHash: HASH })

    resetRail()
    await seedRail()
    await Promise.all([
      noteRegistrationDepositSeen(SIPA, 15n * DAI),
      syncRegistrationRail([swept()]),
    ])
    expect(deposit()).toMatchObject({ phase: "sweeping", sweepTxHash: HASH, amount: "15" })
  })

  // The scan's write lands anywhere inside the observations' own reads and writes.
  it("never undo a phase the scan moves the deposit to meanwhile", async () => {
    for (const phase of ["pendingClaim", "claimed", "recovered"] as const) {
      for (let ticks = 0; ticks < 4; ticks++) {
        resetRail()
        await seedRail()
        const seen = [noteRegistrationDepositSeen(SIPA, 15n * DAI), syncRegistrationRail([swept()])]
        for (let i = 0; i < ticks; i++) await Promise.resolve()
        await Promise.all([...seen, rail().upsert(SIPA as never, { phase })])
        expect(deposit()).toMatchObject({ phase, sweepTxHash: HASH })
      }
    }
  })
})

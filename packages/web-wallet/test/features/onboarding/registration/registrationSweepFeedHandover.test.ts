import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { setIdentity } from "../../../support/identity"
import { loadRecords, type PendingRegistrationRecord } from "@obsidion/front-core"

const IDENTITY = { address: `0x${"cd".repeat(32)}`, handle: "taga", claimedAt: 1 }
vi.mock("../../../../src/config/env", () => ({
  getConfig: () => ({ network: "testnet", l1ChainId: 11155111, l1Chain: { name: "Sepolia" } }),
}))

const { accountRecords } = await import("../../../support/registrationFixtures")
const { registrationForFeed, registrationTagForDeposit, registrationTagForSipa } = await import(
  "../../../../src/features/onboarding/useRegistrationDepositEntry"
)
const { closeSession, session } = await import("../../../../src/session/session")
const { openTestSession } = await import("../../../support/session")
const { seedSipaDeposit, testSipaDeposits } = await import("../../../support/sipaDeposits")

const ACCOUNT = "0x00000000000000000000000000000000000000aa"
const SIPA = "0x00000000000000000000000000000000000000c3"

const record = (over: Partial<PendingRegistrationRecord> = {}): PendingRegistrationRecord =>
  ({
    account: ACCOUNT,
    tag: "taga",
    nameHash: `0x${"77".repeat(32)}`,
    l2Address: IDENTITY.address,
    l1ChainId: 11155111,
    sipaAddress: SIPA,
    fee: "1",
    beneficiary: ACCOUNT,
    depositToken: "0x00000000000000000000000000000000000000d4",
    broadcast: true,
    phase: "funded",
    retries: 0,
    startTime: Date.now(),
    fundedAt: Date.now(),
    ...over,
  } as PendingRegistrationRecord)

const seedDeposit = async (phase: string, amount = "15") => {
  await seedSipaDeposit({
    sipaAddress: SIPA,
    phase,
    networkId: "0xnet",
    amount,
    startTime: Date.now(),
  } as never)
  await loadRecords(testSipaDeposits().view)
}

beforeEach(async () => {
  localStorage.clear()
  openTestSession()
  await accountRecords.upsert(ACCOUNT, {}, record())
})
afterEach(closeSession)

/**
 * One deposit must produce one row. The registration speaks for it until the rail holds the funds;
 * from there the rail's own row and detail show, as for any deposit. The address watch and the
 * detection tick write the funds and the sweep onto the rail, and a manual sweep stamps its own
 * receipt, because the rail's scan learns of the deposit only from the Sweep log.
 */
beforeEach(() => setIdentity(IDENTITY))

describe("registration deposit hands over to the rail exactly once", () => {
  it("the registration speaks while the rail holds nothing at broadcast", async () => {
    await seedDeposit("broadcast", "0")
    expect(registrationForFeed(session())?.tag).toBe("taga")
  })

  it("falls silent once the rail holds the funds, before any sweep", async () => {
    await seedDeposit("broadcast")
    expect(registrationForFeed(session())).toBeNull()
  })

  it("falls silent once the rail is sweeping, so the feed shows one row", async () => {
    await seedDeposit("sweeping")
    expect(registrationForFeed(session())).toBeNull()
  })

  it("stays silent through every phase past the sweep", async () => {
    for (const phase of ["pendingClaim", "claimed", "recoverable", "recovered", "failed"]) {
      await seedDeposit(phase)
      expect(registrationForFeed(session()), `phase ${phase}`).toBeNull()
    }
  })

  it("speaks again once a recovered deposit leaves it waiting for payment", async () => {
    await accountRecords.upsert(
      ACCOUNT,
      { phase: "awaiting_deposit", fundedAt: undefined } as never,
      record(),
    )
    await seedDeposit("recovered", "0.02")
    expect(registrationForFeed(session())?.tag).toBe("taga")
  })

  it("stays silent while the deposit still needs recovery", async () => {
    await accountRecords.upsert(
      ACCOUNT,
      { phase: "awaiting_deposit", fundedAt: undefined } as never,
      record(),
    )
    await seedDeposit("recoverable", "0.02")
    expect(registrationForFeed(session())).toBeNull()
  })

  it("speaks when the rail has no record of the deposit at all", async () => {
    expect(registrationForFeed(session())?.tag).toBe("taga")
  })
})

/** Only the returned deposit's own row drops the registration identity. */
describe("a refunded deposit reads as a plain deposit", () => {
  const awaiting = () =>
    accountRecords.upsert(
      ACCOUNT,
      { phase: "awaiting_deposit", fundedAt: undefined } as never,
      record(),
    )

  it("drops the tag once recovered and the registration waits for payment", async () => {
    await awaiting()
    await seedDeposit("recovered", "0.02")
    expect(registrationTagForDeposit(session(), SIPA)).toBeUndefined()
  })

  it("keeps the registration identity for every other reader", async () => {
    await awaiting()
    await seedDeposit("recovered", "0.02")
    expect(registrationTagForSipa(session(), SIPA)).toBe("taga")
  })

  it("keeps the tag while the deposit still needs recovery or the record is funded", async () => {
    await seedDeposit("recovered", "0.02")
    expect(registrationTagForDeposit(session(), SIPA), "funded").toBe("taga")
    await awaiting()
    await seedDeposit("recoverable", "0.02")
    expect(registrationTagForDeposit(session(), SIPA), "recoverable").toBe("taga")
  })
})

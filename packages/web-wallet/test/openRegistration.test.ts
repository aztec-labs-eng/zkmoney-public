import { beforeEach, describe, expect, it, vi } from "vitest"
import { saveWalletIdentity } from "../src/features/identity/walletIdentity"
import { openRegistration } from "../src/features/onboarding/openRegistration"
import { getPendingStore } from "../src/features/onboarding/webRegistration"
import {
  ACCOUNT,
  L2_ADDRESS,
  pendingRecord,
  resetRegistrationStores,
  seedRegistrationRail,
} from "./support/registrationFixtures"

vi.mock("../src/config/env", () => ({
  getConfig: () => ({ network: "sandbox", l1ChainId: 31337 }),
}))

const record = pendingRecord({ l1ChainId: 31337 })

beforeEach(async () => {
  resetRegistrationStores()
  localStorage.clear()
  await getPendingStore().load()
})

describe("openRegistration", () => {
  it("speaks only for the tag the active wallet still presents as pending", async () => {
    await getPendingStore().upsert(ACCOUNT, {}, record)
    expect(openRegistration()).toBeNull()
    saveWalletIdentity({
      handle: "taga",
      address: `0x${"33".repeat(32)}`,
      claimedAt: 1,
      pending: true,
    })
    expect(openRegistration()).toBeNull()
    saveWalletIdentity({ handle: "taga", address: L2_ADDRESS, claimedAt: 1, pending: false })
    expect(openRegistration()).toBeNull()
    saveWalletIdentity({ handle: "taga", address: L2_ADDRESS, claimedAt: 1, pending: true })
    expect(openRegistration()?.stage).toBe("reserved")
  })

  it("reads the stage the deposit address's rail record shows", async () => {
    saveWalletIdentity({ handle: "taga", address: L2_ADDRESS, claimedAt: 1, pending: true })
    await getPendingStore().upsert(ACCOUNT, {}, record)
    await seedRegistrationRail(record, { phase: "sweeping" })
    expect(openRegistration()?.stage).toBe("sweeping")
  })
})

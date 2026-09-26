import { type PendingRegistrationRecord } from "@obsidion/front-core"
import { getConfig } from "../../../src/config/env"
import { getPendingStore } from "../../../src/features/onboarding/webRegistration"
import { saveRegistrationTerms } from "../../../src/features/onboarding/registrationTerms"
import { DEMO_L2_ADDRESS, DEMO_L1_TOKEN, DEMO_L1_FUNDER } from "../../../src/dev/demoFixtures"
import { SIPA, field } from "./data"

export async function seedRegistration(kind: string) {
  const kinds = ["awaiting", "free", "expired", "wrong-network", "retry", "short", "passkey-mismatch", "passkey-unavailable"]
  if (!kinds.includes(kind)) throw new Error(`Unknown registration fixture: ${kind}`)
  const fee = kind === "free" ? "0" : "10000000000000000000"
  const record: PendingRegistrationRecord = {
    account: "0x00000000000000000000000000000000000000f1", tag: "demo",
    nameHash: field("11") as `0x${string}`, l2Address: DEMO_L2_ADDRESS as `0x${string}`,
    l1ChainId: getConfig().l1ChainId + (kind === "wrong-network" ? 1 : 0),
    sipaAddress: SIPA, fee, beneficiary: DEMO_L1_FUNDER, depositToken: DEMO_L1_TOKEN,
    broadcast: !["retry", "passkey-mismatch", "passkey-unavailable"].includes(kind),
    phase: "awaiting_deposit", retries: kind === "retry" ? 3 : 0,
    startTime: Date.now() - 6 * 60_000,
  }
  await getPendingStore().upsert(record.account, record, record)
  saveRegistrationTerms({
    account: record.account, tag: record.tag,
    deadline: Math.floor(Date.now() / 1000) + (kind === "expired" ? -60 : 3600),
    fee,
    minDeposit: "5000000000000000000", feeWaived: kind === "free",
  })
}

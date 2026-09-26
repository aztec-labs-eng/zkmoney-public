import { describe, expect, it } from "vitest"
import { keccak256 } from "viem"
import type { Address, Hex } from "viem"
import { buildDepositIntent } from "@obsidion/sdk"

import { sipaDeployArgCandidates } from "../../src/oxide/sipaRecovery"

const RECIPIENT_HASH = `0x${"aa".repeat(32)}` as Hex
const RECOVERY = "0x1111111111111111111111111111111111111111" as Address

const deploymentA = {
  sipaFactory: "0x2222222222222222222222222222222222222222" as Address,
  rollupVersion: 7n,
  implementation: "0x5555555555555555555555555555555555555555" as Address,
}
const deploymentB = {
  sipaFactory: "0x6666666666666666666666666666666666666666" as Address,
  rollupVersion: 8n,
  implementation: "0x9999999999999999999999999999999999999999" as Address,
}

const record = { recipientHash: RECIPIENT_HASH, recoveryAddress: RECOVERY }

describe("sipaDeployArgCandidates", () => {
  it("returns nothing for a record missing its identity fields", () => {
    expect(sipaDeployArgCandidates({ ...record, recipientHash: "" }, [deploymentA])).toEqual([])
    expect(sipaDeployArgCandidates({ ...record, recoveryAddress: "" }, [deploymentA])).toEqual([])
    expect(sipaDeployArgCandidates(record, [])).toEqual([])
  })

  it("expands each deployment into both resweepable variants with the full CREATE2 preimage", () => {
    const candidates = sipaDeployArgCandidates(record, [deploymentA, deploymentB])
    expect(candidates).toHaveLength(4)
    expect(candidates.map((c) => c.args.resweepable)).toEqual([true, false, true, false])

    for (const [candidate, deployment] of [
      [candidates[0], deploymentA],
      [candidates[1], deploymentA],
      [candidates[2], deploymentB],
      [candidates[3], deploymentB],
    ] as const) {
      expect(candidate.sipaFactory).toBe(deployment.sipaFactory)
      expect(candidate.args.implementation).toBe(deployment.implementation)
      expect(candidate.protocol).toBe("legacy-eoa")
      expect(candidate.args.rollupVersion).toBe(deployment.rollupVersion)
      expect(candidate.args.recoveryAddress).toBe(RECOVERY)
    }
  })

  it("commits each candidate to the record's recipient hash via the deposit intent", () => {
    const [candidate] = sipaDeployArgCandidates(record, [deploymentA])
    const intent = buildDepositIntent({
      implementation: deploymentA.implementation,
      recipientCommitment: RECIPIENT_HASH,
    })
    expect(candidate.args.intentHash).toBe(intent.intentHash)
    expect(candidate.args.intentHash).toBe(keccak256(intent.intentData))

    // Sensitivity: a different recipient hash must move the commitment.
    const [other] = sipaDeployArgCandidates({ ...record, recipientHash: `0x${"bb".repeat(32)}` }, [
      deploymentA,
    ])
    expect(other.args.intentHash).not.toBe(candidate.args.intentHash)
  })
})

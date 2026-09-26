import type { Fr } from "@aztec/aztec.js/fields"
import { describe, expect, it, vi } from "vitest"
import type { RecoverPasskeyResult } from "@obsidion/sdk"
import {
  resolveRecoveredMsk,
  type AnchorTier,
  type CandidateProbe,
} from "../../src/core/services/resolveRecoveredMsk"

// Sentinel candidates: the resolver only compares them by `toString()` and hands them to probes.
const first = { toString: () => "first-msk" } as never
const second = { toString: () => "second-msk" } as never
const derive = async (msk: Fr) => ((msk as never) === first ? "0xfirst" : "0xsecond")

function recovered(partial: Partial<RecoverPasskeyResult>): RecoverPasskeyResult {
  return {
    authProvider: {} as never,
    credentialId: "cred",
    pubkey: "pub",
    candidates: { first, second },
    preferredSlot: "first",
    hasPersistedSlot: false,
    candidateSource: "webauthn",
    ...partial,
  } as RecoverPasskeyResult
}

/** A probe that anchors the listed addresses and answers absent for the rest. */
const anchoring =
  (...addresses: string[]): CandidateProbe =>
  async (_msk, address) =>
    addresses.includes(address) ? "anchored" : "absent"
const absent: CandidateProbe = async () => "absent"
const tier = (name: string, ...probes: CandidateProbe[]): AnchorTier => ({ name, probes })

describe("resolveRecoveredMsk", () => {
  it("tier 1: a stored address picks the matching candidate and names its slot", async () => {
    const probe = vi.fn(absent)
    const result = await resolveRecoveredMsk(recovered({ expectedAddress: "0xsecond" }), derive, [
      tier("registry", probe),
    ])
    expect(result).toMatchObject({ kind: "resolved", msk: second, slot: "second", tier: "address" })
    expect(probe).not.toHaveBeenCalled()
  })

  it("tier 1: a stored address matching neither candidate throws even when a probe would anchor one", async () => {
    await expect(
      resolveRecoveredMsk(recovered({ expectedAddress: "0xelse" }), derive, [
        tier("registry", anchoring("0xfirst")),
      ]),
    ).rejects.toThrow(/does not match/)
  })

  it("tier 2: one anchored candidate resolves with that tier", async () => {
    const result = await resolveRecoveredMsk(recovered({}), derive, [
      tier("registry", anchoring("0xsecond")),
    ])
    expect(result).toMatchObject({
      kind: "resolved",
      msk: second,
      slot: "second",
      tier: "registry",
    })
  })

  it("tier 2: both candidates anchored is ambiguous, not a guess", async () => {
    const result = await resolveRecoveredMsk(recovered({}), derive, [
      tier("registry", anchoring("0xfirst", "0xsecond")),
    ])
    expect(result).toEqual({ kind: "ambiguous", tier: "registry" })
  })

  it("tiers short-circuit: a later tier is never consulted once one anchors", async () => {
    const later = vi.fn(anchoring("0xfirst", "0xsecond"))
    const result = await resolveRecoveredMsk(recovered({}), derive, [
      tier("registry", anchoring("0xfirst")),
      tier("later", later),
    ])
    expect(result).toMatchObject({ kind: "resolved", slot: "first", tier: "registry" })
    expect(later).not.toHaveBeenCalled()
  })

  it("an absent tier moves on; a later tier may still resolve", async () => {
    const result = await resolveRecoveredMsk(recovered({}), derive, [
      tier("registry", absent),
      tier("later", anchoring("0xfirst")),
    ])
    expect(result).toMatchObject({ kind: "resolved", slot: "first", tier: "later" })
  })

  it("no tier positive is unknown", async () => {
    const result = await resolveRecoveredMsk(recovered({}), derive, [tier("registry", absent)])
    expect(result).toEqual({ kind: "unknown" })
  })

  it("an absent slot is never dereferenced", async () => {
    const probe = vi.fn(anchoring("0xfirst"))
    const result = await resolveRecoveredMsk(
      recovered({ candidates: { first }, preferredSlot: "second" }),
      derive,
      [tier("registry", probe)],
    )
    expect(result).toMatchObject({ kind: "resolved", slot: "first" })
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it("a probe rejection propagates and stops the walk", async () => {
    const later = vi.fn(anchoring("0xfirst"))
    const failing: CandidateProbe = async (_msk, address) => {
      if (address === "0xsecond") throw new Error("rpc down")
      return "absent"
    }
    await expect(
      resolveRecoveredMsk(recovered({}), derive, [tier("registry", failing), tier("later", later)]),
    ).rejects.toThrow(/rpc down/)
    expect(later).not.toHaveBeenCalled()
  })

  it("a probe rejection wins even when another probe in the tier anchors", async () => {
    const failing: CandidateProbe = async () => {
      throw new Error("rpc down")
    }
    await expect(
      resolveRecoveredMsk(recovered({}), derive, [tier("registry", anchoring("0xfirst"), failing)]),
    ).rejects.toThrow(/rpc down/)
  })
})

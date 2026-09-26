import type { Fr } from "@aztec/aztec.js/fields"
import type { PrfSlot } from "@obsidion/core/types"
import type { RecoverPasskeyResult } from "@obsidion/sdk"
import { selectRecoveredMsk } from "./selectRecoveredMsk"

/**
 * Whether an on-chain or off-chain anchor names a candidate master key. `absent` is a positive
 * answer ("nothing here"); a probe that cannot answer rejects, and the rejection aborts recovery.
 */
export type CandidateProbeVerdict = "anchored" | "absent"
export type CandidateProbe = (msk: Fr, l2Address: string) => Promise<CandidateProbeVerdict>

/** Probes of equal trust. Tiers are walked in order; the first tier with any `anchored` decides. */
export type AnchorTier = { name: string; probes: readonly CandidateProbe[] }

export type ResolvedMsk =
  | { kind: "resolved"; msk: Fr; slot: PrfSlot; tier: string }
  /** No tier named a candidate. Nothing may be committed or written. */
  | { kind: "unknown" }
  /** A tier named both candidates. Nothing may be committed or written. */
  | { kind: "ambiguous"; tier: string }

type Candidate = { slot: PrfSlot; msk: Fr; address: string }

/** The fields the resolvers read; a recovery whose public key is not settled yet still carries them. */
export type RecoveredCandidates = Pick<
  RecoverPasskeyResult,
  "candidates" | "preferredSlot" | "expectedAddress" | "candidateSource" | "authenticatorType"
>

/**
 * Decide which of a dual-salt recovery's candidates is the account, without writing anything.
 *
 * A stored expected address is authoritative (`selectRecoveredMsk`; a mismatch throws). Otherwise
 * every present candidate is derived once and, per tier, every probe of every candidate runs in
 * parallel. Exactly one `anchored` candidate resolves; two is `ambiguous`; none moves to the next
 * tier; no tier positive is `unknown`. Any probe rejection is rethrown before a weaker tier is
 * consulted, so an outage never reads as "not found".
 */
export async function resolveRecoveredMsk(
  recovered: RecoveredCandidates,
  deriveAddress: (msk: Fr) => Promise<string>,
  tiers: readonly AnchorTier[],
): Promise<ResolvedMsk> {
  if (recovered.expectedAddress) {
    const msk = await selectRecoveredMsk(recovered, deriveAddress)
    const slot: PrfSlot =
      recovered.candidates.second !== undefined &&
      msk.toString() === recovered.candidates.second.toString()
        ? "second"
        : "first"
    return { kind: "resolved", msk, slot, tier: "address" }
  }

  const order: PrfSlot[] =
    recovered.preferredSlot === "second" ? ["second", "first"] : ["first", "second"]
  const candidates: Candidate[] = []
  for (const slot of order) {
    const msk = recovered.candidates[slot]
    if (msk) candidates.push({ slot, msk, address: await deriveAddress(msk) })
  }

  for (const tier of tiers) {
    const verdicts = await Promise.allSettled(
      candidates.flatMap((candidate) =>
        tier.probes.map(async (probe) => ({
          candidate,
          verdict: await probe(candidate.msk, candidate.address),
        })),
      ),
    )
    const failed = verdicts.find((v) => v.status === "rejected")
    if (failed) throw failed.reason
    const anchored = candidates.filter((candidate) =>
      verdicts.some(
        (v) =>
          v.status === "fulfilled" &&
          v.value.candidate === candidate &&
          v.value.verdict === "anchored",
      ),
    )
    if (anchored.length === 1) {
      const [c] = anchored
      return { kind: "resolved", msk: c!.msk, slot: c!.slot, tier: tier.name }
    }
    if (anchored.length > 1) return { kind: "ambiguous", tier: tier.name }
  }
  return { kind: "unknown" }
}

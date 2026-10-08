/**
 * A pending deposit's processing reason from one capacity eligibility of its own portal. Pure, so the activity row,
 * the detail sheet and the notification derive the same answer from the same read.
 */
import { parseUnits, type Address } from "viem"
import type { SipaPortalTerms } from "@obsidion/sdk"
import type { SIPADepositRecord } from "../core/services/deposits/SIPADepositStore"
import type { SipaProcessingReason } from "../core/services/deposits/sipaProcessing"
import type { CapacityEligibility, RequiredCredit } from "./portalCapacityEligibility"

/**
 * What the portal would meter for this deposit: the whole balance less the route fee and the portal's funding cut.
 * The route fee is the implementation's `DEPOSIT_FEE`, or a registration's signed fee, which is at least that. Both
 * come from the deposit's own implementation and portal, not the record's stored fee, which carries the cut of the
 * deployment selected when it was written.
 *
 * Unknown for a deposit in another token: the sweep converts it first, and no supported bound gives the output.
 */
export function sipaRequiredCredit(
  record: Pick<
    SIPADepositRecord,
    "amount" | "tokenAddress" | "tokenDecimals" | "intent" | "registrationFee"
  >,
  terms: SipaPortalTerms,
): RequiredCredit {
  const unknown: RequiredCredit = { status: "unknown" }
  if (!record.tokenAddress || record.tokenAddress.toLowerCase() !== terms.token.toLowerCase()) {
    return unknown
  }
  if (record.tokenDecimals === undefined) return unknown
  let routeFee = terms.depositFee
  if (record.intent === "registration") {
    if (record.registrationFee === undefined) return unknown
    routeFee = BigInt(record.registrationFee)
    // Below the deposit fee the sweep reverts before the portal is reached.
    if (routeFee < terms.depositFee) return unknown
  }
  let gross: bigint
  try {
    gross = parseUnits(record.amount, record.tokenDecimals)
  } catch {
    return unknown
  }
  const atomic = gross - routeFee - terms.fpcFundingCut
  return atomic > 0n
    ? { status: "known", atomic, token: terms.token as Address, decimals: record.tokenDecimals }
    : unknown
}

/**
 * The reason for one eligibility. `undefined` means the deposit's portal is not known here. A read that is missing,
 * stale or unsupported is reported as such, never as capacity.
 */
export function sipaProcessingReason(
  eligibility: CapacityEligibility | undefined,
  now: number,
): SipaProcessingReason {
  if (!eligibility) return { kind: "unavailable", cause: "portal-unknown" }
  switch (eligibility.kind) {
    case "checking":
      return { kind: "checking" }
    case "exceeds-operation-cap":
      return { kind: "operation-cap", observedAt: now }
    case "stale":
      return {
        kind: "unavailable",
        cause: "capacity-unread",
        last: {
          availableAtomic: eligibility.snapshot.availableAtomic,
          decimals: eligibility.snapshot.decimals,
          observedAt: eligibility.fetchedAt,
        },
      }
    case "unavailable":
      return {
        kind: "unavailable",
        cause: "capacity-unread",
        ...(eligibility.lastSnapshot && eligibility.lastFetchedAt !== undefined
          ? {
              last: {
                availableAtomic: eligibility.lastSnapshot.availableAtomic,
                decimals: eligibility.lastSnapshot.decimals,
                observedAt: eligibility.lastFetchedAt,
              },
            }
          : {}),
      }
    case "unsupported":
      return { kind: "unavailable", cause: "capacity-unread" }
    case "amount-unknown": {
      const { snapshot, fetchedAt } = eligibility
      const observed = { decimals: snapshot.decimals, observedAt: fetchedAt }
      return eligibility.zero
        ? {
            kind: "capacity",
            availableAtomic: 0n,
            refill:
              snapshot.rateAtomicPerSecond === 0n ? { status: "none" } : { status: "unknown" },
            ...observed,
          }
        : {
            kind: "unavailable",
            cause: "amount-unknown",
            availableAtomic: snapshot.availableAtomic,
            ...observed,
          }
    }
    case "exceeds-ceiling":
      return {
        kind: "ceiling",
        requiredAtomic: eligibility.requiredAtomic,
        ceilingAtomic: eligibility.snapshot.globalLimitAtomic,
        decimals: eligibility.snapshot.decimals,
        observedAt: eligibility.fetchedAt,
      }
    case "exceeds-available": {
      const { estimate } = eligibility
      return {
        kind: "capacity",
        requiredAtomic: eligibility.requiredAtomic,
        availableAtomic: eligibility.snapshot.availableAtomic,
        refill:
          estimate.status === "none"
            ? { status: "none" }
            : estimate.status === "supported"
            ? { status: "estimate", seconds: estimate.seconds }
            : { status: "unknown" },
        decimals: eligibility.snapshot.decimals,
        observedAt: eligibility.fetchedAt,
      }
    }
    case "fits":
      return {
        kind: "processing",
        availableAtomic: eligibility.snapshot.availableAtomic,
        decimals: eligibility.snapshot.decimals,
        observedAt: eligibility.fetchedAt,
      }
  }
}

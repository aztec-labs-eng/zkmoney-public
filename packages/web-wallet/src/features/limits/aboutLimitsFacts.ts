/**
 * Maps the product-limit policy and the sponsored-transaction allowance onto the About limits facts.
 * Nothing here reads the chain; the callers pass what their owners already read.
 */
import { PUBLIC_TX_LIMIT_USD } from "@obsidion/core/constants"
import type { AllowanceSnapshot, PortalCapacityState } from "@obsidion/front-core"
import { capacityStateLabel } from "../deposit/fundingCapacity"
import type { CapacityFacts, ProductLimitFacts, SponsorshipFacts } from "./aboutLimitsView"

export function productLimitFacts(): ProductLimitFacts {
  const maximum = { maximumUsd: String(PUBLIC_TX_LIMIT_USD) }
  return { send: maximum, deposit: maximum, withdrawal: maximum }
}

export function sponsorshipFacts(snapshot: AllowanceSnapshot): SponsorshipFacts {
  switch (snapshot.status) {
    case "signed-out":
    case "loading":
      return { state: "loading" }
    case "unavailable":
      return { state: "unavailable" }
  }
  const { state, read } = snapshot
  const refillPeriodSeconds =
    read.allowance.refillPeriod > 0 ? read.allowance.refillPeriod : undefined
  switch (state.kind) {
    case "not-subscribed":
      return {
        state: "not-subscribed",
        maxTx: state.maxTx,
        renews: state.renews,
        refillPeriodSeconds,
      }
    case "available":
      return {
        state: "available",
        uses: state.available,
        maxTx: read.allowance.maxTx,
        renews: state.renews,
        refillPeriodSeconds,
        usage: read.usage,
      }
    case "renewal-unknown":
      return {
        state: "renewal-unknown",
        maxTx: state.maxTx,
        refillPeriodSeconds,
        usage: read.usage,
      }
    case "does-not-renew":
      return { state: "spent", usage: read.usage }
  }
}

/**
 * One capacity store state. The last snapshot of a failed read is not shown; the sheet only says the
 * read failed. `symbol` is the settlement token the bucket is metered in. `panel` is the funding
 * panel's view of a current read with no amount, so both surfaces word it the same way.
 */
export function capacityFacts(
  state: PortalCapacityState | undefined,
  symbol: string,
  panel?: { statusText?: string; offerRetry: boolean },
): CapacityFacts {
  if (!state || state.status === "loading") return { state: "loading" }
  if (state.status === "unavailable" || state.status === "unsupported")
    return { state: state.status }
  const { snapshot, fetchedAt } = state
  return {
    state: state.status,
    observation: {
      available: snapshot.availableAtomic,
      ceiling: snapshot.globalLimitAtomic,
      ratePerSecond: snapshot.rateAtomicPerSecond,
      decimals: snapshot.decimals,
      tokenSymbol: symbol,
      observedAt: fetchedAt,
    },
    label: capacityStateLabel(state, symbol),
    notice: panel?.statusText,
    offerRetry: panel?.offerRetry,
  }
}

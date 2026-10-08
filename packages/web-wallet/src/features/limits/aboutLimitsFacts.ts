/**
 * Maps the product-limit policy and the sponsored-transaction allowance onto the About limits facts.
 * Nothing here reads the chain; the callers pass what their owners already read.
 */
import { PUBLIC_TX_LIMIT_USD } from "@obsidion/core/constants"
import {
  NOMINAL_USD_VALUATION,
  type AllowanceSnapshot,
  type PortalCapacityState,
  type UsdValuation,
} from "@obsidion/front-core"
import { capacityStateLabel } from "../deposit/fundingCapacity"
import type { DepositTokenOption } from "../deposit/loadDepositFacts"
import type { CapacityFacts, ProductLimitFacts, SponsorshipFacts } from "./aboutLimitsView"

/**
 * `valuationOf` values one deposit token by its address. Without it, no token list is shown. A token
 * with any valuation other than the nominal policy rate also hides the list, since its wording
 * names the $1 rate.
 */
export function productLimitFacts({
  tokens,
  valuationOf,
}: {
  tokens: DepositTokenOption[]
  valuationOf?: (token: DepositTokenOption) => UsdValuation | undefined
}): ProductLimitFacts {
  const maximumUsd = String(PUBLIC_TX_LIMIT_USD)
  const facts: ProductLimitFacts = {
    deposit: { maximumUsd, basis: "sent-including-fees" },
    withdrawal: { maximumUsd, basis: "debited-including-fees" },
  }
  if (!valuationOf) return facts
  const valued = tokens.flatMap((token) => {
    const valuation = valuationOf(token)
    return valuation ? [{ symbol: token.symbol, valuation }] : []
  })
  const nominal = valued.every(({ valuation }) => valuation.source === NOMINAL_USD_VALUATION.source)
  if (valued.length > 0 && nominal) facts.valuation = { tokens: valued.map((v) => v.symbol) }
  return facts
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

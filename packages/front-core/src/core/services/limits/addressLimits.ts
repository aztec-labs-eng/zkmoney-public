/**
 * Per-operation limits for a payment made by sending to an address or QR code, per route. Each
 * route states what the payer sends and how much of it the portal credits; the published limit
 * counts the send and the protocol ceiling counts the credit. Shared deposit capacity is a separate
 * check.
 */
import { TX_AMOUNT_CAP } from "@obsidion/sdk"
import type { CapacityEligibility } from "../../../oxide/portalCapacityEligibility"
import {
  checkProtocolCeiling,
  checkPublicLimit,
  floorToTypeable,
  publicLimitAtomic,
  type ProtocolCeilingCheck,
  type PublicLimitCheck,
  type UsdValuation,
} from "./amountLimits"

/** Amounts are in base units of the token the payer sends. */
export type AddressRoute =
  /** A deposit address: the sender picks the amount. A swapped token's credit is set by the swap. */
  | { kind: "deposit"; decimals: number; swap: boolean; feeAtomic?: bigint }
  /** A request with a fixed amount: the payer sends it plus the deposit fee. */
  | { kind: "fixed-request"; decimals: number; requestedAtomic: bigint; feeAtomic: bigint }
  /** A request with no amount. */
  | { kind: "open-request"; decimals: number; feeAtomic: bigint }
  /**
   * A registration deposit: the sweep takes the schedule fee (which includes the relayer's fee)
   * and the portal takes its funding cut before crediting the rest.
   */
  | {
      kind: "registration"
      decimals: number
      askAtomic?: bigint
      scheduleFeeAtomic?: bigint
      fpcCutAtomic?: bigint
    }

export interface AmountBasis {
  /** The fixed amount to send; undefined when the sender picks it. */
  sendAtomic?: bigint
  /** What the portal credits from `sendAtomic`, in settlement-token units; undefined when not known. */
  creditAtomic?: bigint
  /** What comes off any send before the portal credits it; undefined when not known. */
  deductionAtomic?: bigint
}

export function addressAmountBasis(route: AddressRoute): AmountBasis {
  switch (route.kind) {
    case "deposit":
      return { deductionAtomic: route.swap ? undefined : route.feeAtomic }
    case "fixed-request":
      return {
        sendAtomic: route.requestedAtomic + route.feeAtomic,
        creditAtomic: route.requestedAtomic,
        deductionAtomic: route.feeAtomic,
      }
    case "open-request":
      return { deductionAtomic: route.feeAtomic }
    case "registration": {
      const { askAtomic, scheduleFeeAtomic, fpcCutAtomic } = route
      const deductionAtomic =
        scheduleFeeAtomic === undefined || fpcCutAtomic === undefined
          ? undefined
          : scheduleFeeAtomic + fpcCutAtomic
      const creditAtomic =
        askAtomic === undefined || deductionAtomic === undefined
          ? undefined
          : askAtomic > deductionAtomic
          ? askAtomic - deductionAtomic
          : 0n
      return { sendAtomic: askAtomic, creditAtomic, deductionAtomic }
    }
  }
}

/** The largest amount one transfer may send, or undefined when the route cannot establish it. */
export function maximumSendAtomic(
  route: AddressRoute,
  valuation: UsdValuation | undefined,
): bigint | undefined {
  const limit = publicLimitAtomic(route.decimals, valuation)
  if (limit === undefined) return undefined
  // A swapped token is not in settlement-token units, so only the published limit applies to it.
  if (route.kind === "deposit" && route.swap) return limit
  const { deductionAtomic } = addressAmountBasis(route)
  // The protocol ceiling counts the credit, so it allows the send to exceed it by the deductions.
  if (deductionAtomic === undefined) return limit <= TX_AMOUNT_CAP ? limit : undefined
  const ceiling = floorToTypeable(TX_AMOUNT_CAP + deductionAtomic, route.decimals)
  return ceiling < limit ? ceiling : limit
}

/**
 * What the portal credits at the maximum send, or undefined when the route does not state its
 * deductions up front (a swapped token, or a fee not read yet).
 */
export function maximumCreditAtomic(
  route: AddressRoute,
  valuation: UsdValuation | undefined,
): bigint | undefined {
  if (route.kind === "deposit" && route.swap) return undefined
  const { deductionAtomic } = addressAmountBasis(route)
  const maxSend = maximumSendAtomic(route, valuation)
  if (maxSend === undefined || deductionAtomic === undefined) return undefined
  return maxSend > deductionAtomic ? maxSend - deductionAtomic : 0n
}

export interface FixedAmountLimits {
  publicLimit: PublicLimitCheck
  protocolCeiling: ProtocolCeilingCheck
  /** Set only when a check shows the amount cannot be paid in one transfer. */
  over?: "public" | "protocol"
}

/** Checks a route's fixed amount; undefined when the sender picks the amount. */
export function fixedAmountLimits(
  route: AddressRoute,
  valuation: UsdValuation | undefined,
): FixedAmountLimits | undefined {
  const { sendAtomic, creditAtomic } = addressAmountBasis(route)
  if (sendAtomic === undefined) return undefined
  const publicLimit = checkPublicLimit(sendAtomic, route.decimals, valuation)
  const protocolCeiling = checkProtocolCeiling(creditAtomic)
  const over =
    publicLimit === "over" ? "public" : protocolCeiling === "over" ? "protocol" : undefined
  return { publicLimit, protocolCeiling, ...(over ? { over } : {}) }
}

/**
 * The most one transfer can send and still fit `availableAtomic` of shared capacity, or undefined
 * when the route does not state its deductions up front. Never above `maximumSendAtomic`.
 */
export function maximumSendForCapacity(
  route: AddressRoute,
  availableAtomic: bigint,
  valuation: UsdValuation | undefined,
): bigint | undefined {
  const maxSend = maximumSendAtomic(route, valuation)
  if (maxSend === undefined || (route.kind === "deposit" && route.swap)) return undefined
  const { deductionAtomic } = addressAmountBasis(route)
  if (deductionAtomic === undefined) return undefined
  const fits = floorToTypeable(availableAtomic + deductionAtomic, route.decimals)
  return fits < maxSend ? fits : maxSend
}

/**
 * Whether an address or QR code for a payment may be shared, given its capacity reading. A fixed
 * amount that known capacity cannot take is held. Anything short of a fresh reading that fits
 * warns, because the wallet cannot stop a transfer once the address is shared.
 */
export type AddressShareDecision = "allow" | "warn-zero" | "warn-unknown" | "block"

export function addressShareDecision(
  eligibility: CapacityEligibility,
  fixedAmount: boolean,
): AddressShareDecision {
  switch (eligibility.kind) {
    case "exceeds-operation-cap":
    case "exceeds-ceiling":
    case "exceeds-available":
      return "block"
    case "fits":
      return "allow"
    case "amount-unknown":
      if (eligibility.zero) return "warn-zero"
      return fixedAmount ? "warn-unknown" : "allow"
    default:
      return "warn-unknown"
  }
}

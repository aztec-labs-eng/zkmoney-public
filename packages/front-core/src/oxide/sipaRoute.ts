import { SipaIntent } from "@oxide/l1-contracts"
import type { SipaRoute } from "@obsidion/sdk"
import {
  bridgeUnderlying,
  requireNonZeroL1Address,
  sipaIntentToken,
  type SipaIntentName,
} from "@obsidion/core/oxide"
import type { OxideEnvTuple } from "@obsidion/core/types"
import type { Address } from "viem"
import type { SIPADepositRecord } from "../core/services/deposits/SIPADepositStore"

const INTENT_NAMES: Record<SipaIntent, SipaIntentName | undefined> = {
  [SipaIntent.None]: undefined,
  [SipaIntent.Deposit]: "deposit",
  [SipaIntent.Registration]: "registration",
  [SipaIntent.UserOp]: "user-op",
}

/** The row intent of a factory intent. */
export function sipaIntentName(intent: SipaIntent): SipaIntentName {
  const name = INTENT_NAMES[intent]
  if (!name) throw new Error(`SIPA intent ${intent} has no forwarding-table row`)
  return name
}

/**
 * The deployment table's row for `intent` and `token`, by the one fee-token rule: a deposit settles on the row of the
 * token it funds, the bridge's own by default; every other intent on the fee token's row.
 */
export function deploymentSipaRoute(
  tuple: Pick<OxideEnvTuple, "forwardingTable" | "token" | "underlying" | "feeToken">,
  intent: SipaIntent = SipaIntent.Deposit,
  token: string = bridgeUnderlying(tuple),
): SipaRoute {
  return {
    forwardingTable: requireNonZeroL1Address(tuple.forwardingTable, "forwardingTable") as Address,
    token: requireNonZeroL1Address(
      sipaIntentToken(tuple, sipaIntentName(intent), token),
      "token",
    ) as Address,
    intent,
  }
}

/** A recorded SIPA's forwarding-table row, less the token: the deployment's settlement token keys every one. */
export type SipaRecordRoute = Omit<SipaRoute, "token">

/**
 * The record intent of a factory intent; a deposit's is the record's default. Null for an intent the
 * wallet never records.
 */
export function sipaRecordIntentOf(intent: SipaIntent): SIPADepositRecord["intent"] | null {
  if (intent === SipaIntent.Deposit) return undefined
  if (intent === SipaIntent.Registration) return "registration"
  if (intent === SipaIntent.UserOp) return "user-op"
  return null
}

/** The factory intent a recorded SIPA commits to. */
export function sipaRecordIntent(intent: SIPADepositRecord["intent"]): SipaIntent {
  if (intent === "registration") return SipaIntent.Registration
  if (intent === "user-op") return SipaIntent.UserOp
  return SipaIntent.Deposit
}

/** The row a recorded SIPA's sweeps route through. Undefined without an origin that names its table. */
export function sipaRecordRoute(
  record: Pick<SIPADepositRecord, "origin" | "intent">,
): SipaRecordRoute | undefined {
  const origin = record.origin
  if (origin?.protocol !== "account" || !origin.forwardingTable) return undefined
  return { forwardingTable: origin.forwardingTable, intent: sipaRecordIntent(record.intent) }
}

/** One cache key per row. */
export function sipaRouteKey(route: SipaRecordRoute): string {
  return `${route.forwardingTable.toLowerCase()}:${route.intent}`
}

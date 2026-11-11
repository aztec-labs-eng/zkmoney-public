import {
  isAllZeroHex,
  sipaGenerationOf,
  type OxideDeploymentTable,
  type SipaIntentName,
} from "@obsidion/core/oxide"
import type { SipaSweepRoute } from "@obsidion/sdk"
import type { Address } from "viem"
import { depositTokenRoutes } from "./depositTokenRoutes"

/**
 * The sweeps a SIPA of `table` needs so that every token it accepts for `intent` is swept, each through its settling
 * row's subsidy. Relayers never rewrite an operation, so a token the broadcast leaves out stays at the address. A
 * registration or metadata update settles on the fee token's row alone. A SIPA of an earlier set, named by its
 * `sipaFactory`, sweeps through that set's subsidies.
 */
export function sipaSweepRoutes(
  table: OxideDeploymentTable,
  chainId: number | bigint,
  intent: SipaIntentName,
  sipaFactory?: string,
): SipaSweepRoute[] {
  const accepted = depositTokenRoutes(table, chainId, intent)
  if (!accepted.length) {
    throw new Error(`The forwarding table routes no ${intent} sweep of any token`)
  }
  return accepted.map(({ token, row }) => {
    const { tuple } = row.bridge
    const forwardingTable = table.deployment.forwardingTable
    const depositSubsidy =
      (sipaFactory && sipaGenerationOf(tuple, { sipaFactory, forwardingTable })?.depositSubsidy) ||
      tuple.depositSubsidy
    if (!depositSubsidy || isAllZeroHex(depositSubsidy)) {
      throw new Error(`Bridge ${row.bridge.key ?? row.bridge.portal} publishes no deposit subsidy`)
    }
    return {
      token,
      portal: row.bridge.portal as Address,
      depositSubsidy: depositSubsidy as Address,
    }
  })
}

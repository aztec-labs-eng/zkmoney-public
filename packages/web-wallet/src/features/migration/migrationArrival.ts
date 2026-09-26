/**
 * A migration's arrival address is published before its burn, as a child operation of the
 * migration: the relayer sweeps only a published address, so a burn never goes out until the
 * chain includes the publish.
 */
import type { ContractService, ObsidionWallet, SelfResolvedSipa } from "@obsidion/sdk"
import { usd } from "../../ui/format"
import { getSipaDepositGateway } from "../deposit/sipaGateway"
import { runOperation } from "../operations/operations"

/** The one line both the migration and its arrival show, from a decimal amount. */
export function migrationSummary(amount: string): string {
  return `${usd(Number(amount))} to the new version`
}

/**
 * Publish `sipa` inside the migration `parent`; resolves once the chain includes it. The gateway
 * re-derives the address from `(day, nonce)` and refuses one that moved.
 */
export function publishMigrationArrival(
  deps: { wallet: ObsidionWallet; contractService: ContractService },
  sipa: SelfResolvedSipa,
  summary: string,
  parent: string,
): Promise<void> {
  const operationId = `migration-arrival_${crypto.randomUUID()}`
  return runOperation(
    { operationId, flow: "migration-arrival", summary, parent },
    () =>
      getSipaDepositGateway().broadcastResolvedSipa(
        deps.wallet,
        deps.contractService,
        sipa,
        operationId,
      ),
  )
}

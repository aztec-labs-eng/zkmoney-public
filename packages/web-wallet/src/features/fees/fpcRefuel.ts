/**
 * Post-tx ClaimFPC top-up trigger. Every sponsored gateway calls `maybeRefuelFpc` from its tail,
 * strictly after its own send resolved (the wallet serializes local proving). The service does the
 * real work — threshold check, L1 skim-deposit discovery, the `refuel` send — and debounces
 * internally, so call sites stay one fire-and-forget line. Nothing here may throw into a user flow.
 */
import { createPublicClient } from "viem"
import {
  FpcRefuelService,
  type ContractService,
  type FpcRefuelTarget,
  type ObsidionWallet,
} from "@obsidion/sdk"
import { DEFAULT_CONTRACTS } from "@obsidion/core/constants"
import { getConfig, l1ChainFor, l1Transport } from "../../config/env"

let service: FpcRefuelService | undefined

async function resolveFpc(contractService: ContractService): Promise<FpcRefuelTarget | undefined> {
  const address = await contractService.getContractAddress(DEFAULT_CONTRACTS.claimFpc)
  if (!address) return undefined
  const artifact = await contractService.getArtifactForContract(DEFAULT_CONTRACTS.claimFpc, address)
  return { address, artifact }
}

export function maybeRefuelFpc(deps: {
  wallet: ObsidionWallet
  contractService: ContractService
  /**
   * The FPC that sponsored the flow — each portal generation's L1 funder deposits to its own
   * FPC, so a retired-generation sponsor refuels its own instance. Omitted: the current one.
   */
  fpc?: FpcRefuelTarget
}): void {
  try {
    const config = getConfig()
    service ??= new FpcRefuelService(
      deps.wallet,
      deps.wallet.node,
      () => resolveFpc(deps.contractService),
      createPublicClient({ chain: l1ChainFor(config.l1ChainId), transport: l1Transport(config) }),
      { threshold: config.fpcRefuelThreshold },
    )
    void service.maybeRefuel(deps.fpc)
  } catch (error) {
    console.warn("[fpcRefuel] skipped:", error)
  }
}

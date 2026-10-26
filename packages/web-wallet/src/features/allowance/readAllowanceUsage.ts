/**
 * What spent the account's current sponsored allowance: its own batches or deposit-address
 * broadcasts. A failed read returns undefined, so the count still shows without the split.
 */
import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import { DEFAULT_CONTRACTS } from "@obsidion/core/constants"
import { readClaimFpcSubscriptionNotes } from "@obsidion/sdk"
import {
  allowanceUsage,
  currentAllowanceNotes,
  type AllowanceRead,
  type AllowanceUsage,
} from "@obsidion/front-core"
import type { ClaimSponsorDeps } from "../onboarding/claimSponsorship"
import { getSipaDepositGateway } from "../deposit/sipaGateway"

/** The split of `read`'s allowance, on the instance and rail that read used. */
export async function readAllowanceUsage(
  deps: ClaimSponsorDeps,
  read: AllowanceRead,
): Promise<AllowanceUsage | undefined> {
  try {
    const user = deps.account.getAddress()
    const fpcAddress = AztecAddress.fromStringUnsafe(read.fpcAddress)
    const fpcArtifact = await deps.contractService.getArtifactForContract(
      DEFAULT_CONTRACTS.claimFpc,
      fpcAddress,
    )
    // The notes are the payer's; the broadcasts that spent them are the payer's own before a
    // rotation and the acting account's after it.
    const payer = AztecAddress.fromStringUnsafe(read.payer)
    const notes = await readClaimFpcSubscriptionNotes(
      deps.wallet,
      fpcAddress,
      fpcArtifact,
      payer,
      read.railId,
    )
    const current = currentAllowanceNotes(notes)
    if (current.length === 0) return undefined
    const fromBlock = Math.min(...current.map((note) => note.blockNumber))
    const gateway = getSipaDepositGateway()
    const broadcasts = new Set<string>()
    for (const account of payer.equals(user) ? [user] : [payer, user]) {
      for (const hash of await gateway.broadcastTxHashes(deps.wallet, account, fromBlock)) {
        broadcasts.add(hash)
      }
    }
    return allowanceUsage(current, read.allowance.maxTx, broadcasts)
  } catch (error) {
    console.warn("[allowance] usage split unavailable:", error)
    return undefined
  }
}

import type { Address, PublicClient } from "viem"
import { predictLegacySIPA, predictSIPA } from "@obsidion/sdk"
import type { SipaRecoverCandidate } from "@obsidion/front-core"

/** The address `candidate` deploys to, read from its own factory. */
export function predictSipaCandidate(
  publicClient: PublicClient,
  candidate: SipaRecoverCandidate,
): Promise<Address> {
  return candidate.protocol === "legacy-eoa"
    ? predictLegacySIPA(publicClient, candidate.sipaFactory, candidate.args)
    : predictSIPA(
        publicClient as never,
        candidate.sipaFactory,
        candidate.args.implementation,
        candidate.args.intentHash,
        candidate.args.recoveryCommitment,
        candidate.args.rollupVersion,
        candidate.args.resweepable,
        candidate.args.forwardingTable,
      )
}

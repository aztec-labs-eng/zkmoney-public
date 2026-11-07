import { decodeAbiParameters, type Address, type PublicClient } from "viem"
import { predictLegacySIPA, predictSIPA } from "@obsidion/sdk"
import type { EncodedSipaDeploy, SipaRecoverCandidate } from "@obsidion/front-core"

/** The address `candidate` deploys to, read from its own factory. */
export async function predictSipaCandidate(
  publicClient: PublicClient,
  candidate: SipaRecoverCandidate | EncodedSipaDeploy,
): Promise<Address> {
  if ("deployCall" in candidate) {
    // `deploySIPA` returns the clone's address, so a simulated call predicts it in any ABI.
    const { data } = await publicClient.call({
      to: candidate.sipaFactory,
      data: candidate.deployCall,
    })
    if (!data) throw new Error(`${candidate.sipaFactory} returned no SIPA address`)
    return decodeAbiParameters([{ type: "address" }], data)[0]
  }
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

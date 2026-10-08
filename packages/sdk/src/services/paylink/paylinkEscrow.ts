import { Fr } from "@aztec/aztec.js/fields"
import {
  type ContractInstanceWithAddress,
  getContractInstanceFromInstantiationParams,
} from "@aztec/stdlib/contract"
import { type ContractService, DEFAULT_CONTRACTS, type ContractName } from "@obsidion/contracts"
import { derivePaylinkKeys } from "./paylinkKeys.js"

export type PaylinkFlavor = "direct" | "email"

export function paylinkTypeOf(flavor: PaylinkFlavor): ContractName {
  return flavor === "email" ? DEFAULT_CONTRACTS.paylinkEmail : DEFAULT_CONTRACTS.paylinkDirect
}

/**
 * The escrow a secret and fallback key hash derive under the flavor's current class: salt 0, no
 * initializer, so the address is a pure function of the keys. What a transfer's paylink lane is
 * checked against.
 */
export async function paylinkEscrowInstance(
  contractService: Pick<ContractService, "getArtifactForContract">,
  flavor: PaylinkFlavor,
  secret: Fr,
  fallbackKeyHash: Fr,
): Promise<ContractInstanceWithAddress> {
  const artifact = await contractService.getArtifactForContract(paylinkTypeOf(flavor))
  const keys = await derivePaylinkKeys({ secretKey: secret, fallbackKeyHash })
  return getContractInstanceFromInstantiationParams(artifact, {
    salt: new Fr(0n),
    publicKeys: keys.publicKeys,
  })
}

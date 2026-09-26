import { ContractInstanceWithAddress } from "@aztec/stdlib/contract"
import type { ContractArtifact } from "@aztec/stdlib/abi"
import { Fr } from "@aztec/foundation/curves/bn254"
import { getContractInstanceFromInstantiationParams } from "@aztec/stdlib/contract"
import { SPONSORED_FPC_SALT } from "@aztec/constants"
import { PXE } from "@aztec/pxe/client/lazy"
import { SponsoredFeePaymentMethod } from "@aztec/aztec.js/fee"
import { AztecAddress } from "@aztec/stdlib/aztec-address"

export async function getSponsoredFeePaymentMethod(pxe: PXE) {
  const paymentContract = await getDeployedSponsoredFPCAddress(pxe)
  return new SponsoredFeePaymentMethod(paymentContract)
}

// Lazy: the upstream SponsoredFPC artifact is a ~1.5MB JSON that only test/sandbox
// fee paths touch — keep it out of the entry chunk.
let _sponsoredFpcArtifact: Promise<ContractArtifact> | null = null
const getSponsoredFpcArtifact = (): Promise<ContractArtifact> => {
  _sponsoredFpcArtifact ??= import("@aztec/noir-contracts.js/SponsoredFPC").then(
    (m) => m.SponsoredFPCContract.artifact,
  )
  return _sponsoredFpcArtifact
}

export async function getSponsoredFPCInstance(): Promise<ContractInstanceWithAddress> {
  return await getContractInstanceFromInstantiationParams(await getSponsoredFpcArtifact(), {
    salt: new Fr(SPONSORED_FPC_SALT),
  })
}

export async function getSponsoredFPCAddress() {
  return (await getSponsoredFPCInstance()).address
}

export async function getDeployedSponsoredFPCAddress(pxe: PXE) {
  const fpc = await getSponsoredFPCAddress()
  const contracts = await pxe.getContracts()
  if (!contracts.find((c: AztecAddress) => c.equals(fpc))) {
    throw new Error("SponsoredFPC not deployed.")
  }
  return fpc
}

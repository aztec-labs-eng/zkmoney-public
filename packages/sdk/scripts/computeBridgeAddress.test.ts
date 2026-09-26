import { describe, it } from "vitest"
import { loadContractArtifact } from "@aztec/stdlib/abi"
import { NoirCompiledContract } from "@aztec/stdlib/noir"
import { getContractInstanceFromInstantiationParams } from "@aztec/stdlib/contract"
import { AztecAddress, EthAddress } from "@aztec/aztec.js/addresses"
import { Fr } from "@aztec/aztec.js/fields"

// pnpm test:sandbox scripts/computeBridgeAddress.test.ts

describe("computeBridgeAddress", () => {
  it("compute deterministic bridge address", async () => {
    // Load the oxide-token (L2 bridge) artifact
    const artifactJson = await import(
      "../src/artifacts/target/oxide_token_contract/oxide_token_contract-OxideToken.json"
    )
    const artifact = loadContractArtifact(artifactJson as unknown as NoirCompiledContract)

    // OxideTokenContract.constructor(portal_address: EthAddress).
    // Using ZERO portal — set per-deploy.
    const constructorArgs = [EthAddress.ZERO]

    const instance = await getContractInstanceFromInstantiationParams(artifact, {
      constructorArgs,
      salt: new Fr(0n),
      deployer: AztecAddress.ZERO, // universalDeploy
    })

    console.log("Deterministic bridge address:", instance.address.toString())
    console.log("Bridge address as field:", instance.address.toField().toString())
    console.log(
      "Bridge address hex:",
      `0x${instance.address.toField().toBigInt().toString(16).padStart(64, "0")}`,
    )
  })
})

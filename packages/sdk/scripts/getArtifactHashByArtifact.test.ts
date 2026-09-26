import { loadContractArtifact } from "@aztec/stdlib/abi"
import { computeArtifactHash, getContractClassFromArtifact } from "@aztec/stdlib/contract"
import { describe, it } from "vitest"
import { NoirCompiledContract } from "@aztec/stdlib/noir"

// pnpm test:sandbox scripts/getArtifactHashByArtifact.test.ts

describe("Script", async () => {
  it("compute webauthnModule artifact hash, class id, and preimage", async () => {
    const artifactJson = await import(
      "../src/artifacts/target/webauthn/webauthn_authenticator-WebauthnModule.json"
    )
    const artifact = loadContractArtifact(artifactJson as unknown as NoirCompiledContract)

    console.log("artifact.name:", artifact.name)
    console.log("artifact.functions.length:", artifact.functions.length)
    for (const fn of artifact.functions) {
      console.log(`  fn=${fn.name} type=${fn.functionType} bytecodeLen=${fn.bytecode.length}`)
    }
    console.log("nonDispatchPublicFunctions.length:", artifact.nonDispatchPublicFunctions?.length)

    const artifactHash = await computeArtifactHash(artifact)
    console.log("artifactHash:", artifactHash.toString())

    const contractClass = await getContractClassFromArtifact(artifact)
    console.log("contractClassId:", contractClass.id.toString())
    console.log("artifactHash:", contractClass.artifactHash.toString())
    console.log("privateFunctionsRoot:", contractClass.privateFunctionsRoot.toString())
    console.log("publicBytecodeCommitment:", contractClass.publicBytecodeCommitment.toString())
  })
})

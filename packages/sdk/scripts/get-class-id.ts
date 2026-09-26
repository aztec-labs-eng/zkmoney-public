import { loadContractArtifact } from "@aztec/stdlib/abi"
import { getContractClassFromArtifact } from "@aztec/stdlib/contract"
import { readFileSync } from "fs"
import type { NoirCompiledContract } from "@aztec/stdlib/noir"

async function main() {
  const artifactPath = process.argv[2]
  if (!artifactPath) {
    console.error("Usage: tsx scripts/get-class-id.ts <artifact-path>")
    process.exit(1)
  }
  const artifact = loadContractArtifact(
    JSON.parse(readFileSync(artifactPath, "utf-8")) as NoirCompiledContract,
  )
  const cls = await getContractClassFromArtifact(artifact)
  console.log(cls.id.toString())
}

main()

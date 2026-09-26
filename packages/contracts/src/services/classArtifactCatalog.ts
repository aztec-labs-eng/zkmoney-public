import { loadContractArtifact, type ContractArtifact } from "@aztec/stdlib/abi"
import type { NoirCompiledContract } from "@aztec/stdlib/noir"
import { getContractClassFromArtifact } from "@aztec/stdlib/contract"

export interface ClassArtifactPin {
  url: string
  sha256: string
}

export type ClassArtifactCatalog = Record<string, ClassArtifactPin>
export type ClassArtifactPinResolver = (classId: string) => Promise<ClassArtifactPin>

export function createClassArtifactResolver(
  source: ClassArtifactCatalog | ClassArtifactPinResolver,
  fetcher: typeof fetch = fetch,
) {
  const cache = new Map<string, Promise<ContractArtifact>>()
  const resolvePin: ClassArtifactPinResolver =
    typeof source === "function"
      ? source
      : async (classId) => {
          const pin = source[classId]
          if (!pin) throw new Error(`No reviewed artifact for class ${classId}`)
          return pin
        }
  return (classId: string): Promise<ContractArtifact> => {
    let pending = cache.get(classId)
    if (!pending) {
      pending = (async () => {
        const pin = await resolvePin(classId)
        if (!/^[0-9a-f]{64}$/.test(pin.sha256))
          throw new Error(`Invalid reviewed artifact checksum for class ${classId}`)
        const url = new URL(pin.url)
        if (url.protocol !== "https:" || url.username || url.password)
          throw new Error("Historical artifact requires an HTTPS URL without credentials")
        const response = await fetcher(url, {
          signal: AbortSignal.timeout(30000),
          redirect: "error",
        })
        if (!response.ok) throw new Error(`Historical artifact HTTP ${response.status}`)
        const bytes = await response.arrayBuffer()
        const digest = Array.from(
          new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes)),
          (b) => b.toString(16).padStart(2, "0"),
        ).join("")
        if (digest !== pin.sha256)
          throw new Error(`Historical artifact checksum differs for ${classId}`)
        const artifact = loadContractArtifact(
          JSON.parse(new TextDecoder().decode(bytes)) as NoirCompiledContract,
        )
        if ((await getContractClassFromArtifact(artifact)).id.toString() !== classId)
          throw new Error(`Historical artifact class differs from ${classId}`)
        return artifact
      })().catch((error) => {
        cache.delete(classId)
        throw error
      })
      cache.set(classId, pending)
    }
    return pending
  }
}

export async function resolveInstanceArtifact(
  node: {
    getContract(
      address: import("@aztec/stdlib/aztec-address").AztecAddress,
    ): Promise<{ currentContractClassId: { toString(): string } } | undefined>
  },
  address: import("@aztec/stdlib/aztec-address").AztecAddress,
  fallback: () => Promise<ContractArtifact>,
  resolve?: (classId: string) => Promise<ContractArtifact>,
): Promise<ContractArtifact> {
  if (!resolve) return fallback()
  const instance = await node.getContract(address)
  if (!instance) throw new Error(`Historical instance is missing at ${address}`)
  const classId = instance.currentContractClassId.toString()
  const bundled = await fallback()
  if ((await getContractClassFromArtifact(bundled)).id.toString() === classId) return bundled
  const artifact = await resolve(classId)
  if ((await getContractClassFromArtifact(artifact)).id.toString() !== classId)
    throw new Error("Historical artifact class differs from the live instance")
  return artifact
}

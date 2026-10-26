import { poseidon2Hash } from "@aztec-labs/foundation/crypto/poseidon"
import { Fr } from "@aztec-labs/foundation/curves/bn254"
import type { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import {
  countArgumentsSize,
  decodeFromAbi,
  getFunctionReturnType,
  type AbiDecoded,
  type ContractArtifact,
} from "@aztec-labs/stdlib/abi"

/** The node read this needs; utility simulations read the same public storage. */
export interface PublicStorageReader {
  getPublicStorageAt(block: "latest", contract: AztecAddress, slot: Fr): Promise<Fr>
}

/**
 * A `PublicImmutable` value read straight from public storage, typed by the utility function that
 * returns it. It needs no PXE registration and no simulation, so a contract the PXE has never seen
 * costs no class hash. aztec-nr has no TypeScript reader for this layout yet: docs/conventions/
 * public-immutable-reads.md records why this one is local and what removes it.
 *
 * aztec-nr's `WithHash` stores the packed value at `slot..slot+N-1` and its poseidon2 hash at
 * `slot+N`. The hash is checked, and a zero hash means the value was never initialized.
 */
export async function readPublicImmutable(
  node: PublicStorageReader,
  contract: AztecAddress,
  artifact: ContractArtifact,
  storageName: string,
  readerName: string,
): Promise<AbiDecoded> {
  const slot = artifact.storageLayout[storageName]?.slot
  if (!slot) throw new Error(`${artifact.name} has no storage named ${storageName}`)
  const reader = artifact.functions.find((fn) => fn.name === readerName)
  if (!reader) throw new Error(`${artifact.name} has no function named ${readerName}`)
  const returnType = getFunctionReturnType(reader)
  if (!returnType) throw new Error(`${artifact.name}.${readerName} returns nothing`)
  const size = countArgumentsSize({
    ...reader,
    parameters: [{ name: "r", type: returnType, visibility: "public" }],
  })
  const fields = await Promise.all(
    Array.from({ length: size + 1 }, (_, i) =>
      node.getPublicStorageAt("latest", contract, slot.add(new Fr(i))),
    ),
  )
  const packed = fields.slice(0, size)
  const hash = fields[size]!
  if (hash.isZero()) throw new Error(`${artifact.name}.${storageName} at ${contract} is not set`)
  if (!(await poseidon2Hash(packed)).equals(hash))
    throw new Error(`${artifact.name}.${storageName} at ${contract} does not match its hash`)
  return decodeFromAbi(returnType, packed)
}

import { mkdirSync, readFileSync, writeFileSync } from "fs"
import { dirname, resolve } from "path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Barretenberg, UltraHonkBackend, UltraHonkVerifierBackend } from "@aztec-foundation/bb.js"
import { poseidon2Hash } from "@aztec-labs/foundation/crypto/poseidon"
import { Noir, type CompiledCircuit } from "@aztec-foundation/noir-noir_js"
import { hashMessage, hexToBytes, toHex } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { ELIGIBILITY_SIGN_MESSAGE, ELIGIBILITY_VK_BASE64 } from "@obsidion/core/constants"

const CIRCUIT_PATH = resolve(
  __dirname,
  "../../../contracts/src/artifacts/target/eligibility/eligibility.json",
)
const TREE_DEPTH = 19
const PAST_USER = 1n
// The campaign's nullifier for this key's signature; it must survive the move.
const CAMPAIGN_NULLIFIER =
  18446540441679897329889196622992952050830878484121347127091100538641101703449n
const signer = privateKeyToAccount(`0x${"11".repeat(32)}`)
// The account-service fixture's bootstrap subject (private key 0x42…42).
const OWNER = "0x17c5185167401ed00cf5f5b2fc97d9bbfdb7d025"

const field = (v: bigint | string) => toHex(BigInt(v), { size: 32 })
const bytes = (hex: string) => Array.from(hexToBytes(hex as `0x${string}`))
const hash2 = async (l: bigint, r: bigint) => (await poseidon2Hash([l, r])).toBigInt()

/** A tree holding one leaf at index 0, so the path is the empty-subtree hashes. */
async function oneLeafTree(leaf: bigint) {
  const path = [0n]
  for (let i = 1; i < TREE_DEPTH; i++) path.push(await hash2(path[i - 1]!, path[i - 1]!))
  let root = leaf
  for (const sibling of path) root = await hash2(root, sibling)
  return { root, path }
}

describe("eligibility circuit", () => {
  let api: Barretenberg
  let proof: Uint8Array
  let publicInputs: string[]
  let root: bigint

  beforeAll(async () => {
    const circuit = JSON.parse(readFileSync(CIRCUIT_PATH, "utf-8")) as CompiledCircuit
    const signature = await signer.signMessage({ message: ELIGIBILITY_SIGN_MESSAGE })
    const tree = await oneLeafTree(await hash2(PAST_USER, BigInt(signer.address)))
    root = tree.root
    const { witness } = await new Noir(circuit).execute({
      merkle_root: field(root),
      category: field(PAST_USER),
      owner: OWNER,
      address: signer.address,
      signature: bytes(signature.slice(0, 130)),
      pub_key_x: bytes(`0x${signer.publicKey.slice(4, 68)}`),
      pub_key_y: bytes(`0x${signer.publicKey.slice(68)}`),
      message_hash: bytes(hashMessage(ELIGIBILITY_SIGN_MESSAGE)),
      merkle_path: tree.path.map(field),
      merkle_index_bits: Array(TREE_DEPTH).fill(false),
    })
    api = await Barretenberg.new({ threads: 1 })
    ;({ proof, publicInputs } = await new UltraHonkBackend(circuit.bytecode, api).generateProof(
      witness,
    ))
  }, 300_000)

  afterAll(async () => {
    await api?.destroy()
  })

  const verify = (inputs: string[]) =>
    new UltraHonkVerifierBackend(api).verifyProof({
      proof,
      publicInputs: inputs,
      verificationKey: Buffer.from(ELIGIBILITY_VK_BASE64, "base64"),
    })

  it("exposes the root, category, owner and the campaign's nullifier", () => {
    expect(publicInputs).toEqual([root, PAST_USER, OWNER, CAMPAIGN_NULLIFIER].map(field))
    const out = process.env.ELIGIBILITY_FIXTURE_OUT
    if (out) {
      mkdirSync(dirname(out), { recursive: true })
      writeFileSync(out, JSON.stringify({ proof: toHex(proof), publicInputs }, null, 2) + "\n")
    }
  })

  it("verifies with the pinned key", async () => {
    expect(await verify(publicInputs)).toBe(true)
  }, 60_000)

  it("does not verify for another owner", async () => {
    const other = [...publicInputs]
    other[2] = field(`0x${"43".repeat(20)}`)
    expect(await verify(other)).toBe(false)
  }, 60_000)
})

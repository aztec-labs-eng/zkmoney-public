/**
 * The past-user proof's witness, built from the old wallet's signature and the served leaf file
 * (the eligible leaves' Poseidon2 hashes, sorted, 32 bytes each). The old address is a private
 * input: it stays in the browser, and only the proof leaves it.
 */
import { BarretenbergSync } from "@aztec-foundation/bb.js"
import { ELIGIBILITY_SIGN_MESSAGE } from "@obsidion/core/constants"
import {
  bytesToHex,
  hashMessage,
  hexToBytes,
  numberToHex,
  parseSignature,
  recoverAddress,
  recoverPublicKey,
  type Hex,
} from "viem"

const TREE_DEPTH = 19
const PAST_USER = 1n
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n

export class NotPastUserError extends Error {}

type Hash = (left: Uint8Array, right: Uint8Array) => Uint8Array

const field = (value: bigint | Hex) => hexToBytes(numberToHex(BigInt(value), { size: 32 }))

function indexOf(leaves: Uint8Array, leaf: Hex): number {
  let [low, high] = [0, leaves.length / 32 - 1]
  while (low <= high) {
    const mid = (low + high) >>> 1
    const at = bytesToHex(leaves.subarray(mid * 32, mid * 32 + 32))
    if (at === leaf) return mid
    if (at < leaf) low = mid + 1
    else high = mid - 1
  }
  return -1
}

/** Leaves fill from index 0; a missing node is the empty subtree of its level. */
function merklePath(leaves: Uint8Array, index: number, hash: Hash) {
  let layer = leaves
  let empty = new Uint8Array(32)
  const siblings: Hex[] = []
  for (let level = 0; level < TREE_DEPTH; level++) {
    const count = layer.length / 32
    const node = (i: number) => (i < count ? layer.subarray(i * 32, i * 32 + 32) : empty)
    siblings.push(bytesToHex(node(index ^ 1)))
    const next = new Uint8Array(Math.ceil(count / 2) * 32)
    for (let i = 0; i < count; i += 2) next.set(hash(node(i), node(i + 1)), i * 16)
    layer = next
    empty = hash(empty, empty)
    index >>= 1
  }
  return { root: bytesToHex(layer.subarray(0, 32)), siblings }
}

function lowS(signature: Hex): number[] {
  const { r, s } = parseSignature(signature)
  const value = BigInt(s)
  return [...hexToBytes(r), ...field(value > SECP256K1_N / 2n ? SECP256K1_N - value : value)]
}

const leafOf = (api: BarretenbergSync, address: Hex) =>
  bytesToHex(api.poseidon2Hash({ inputs: [field(PAST_USER), field(address)] }).hash)

/** Whether `address` is on the past-user list, checked without a signature. */
export async function isPastUserAddress(address: Hex, leaves: Uint8Array): Promise<boolean> {
  return indexOf(leaves, leafOf(await BarretenbergSync.initSingleton(), address)) >= 0
}

export async function pastUserInputs(req: {
  signature: Hex
  owner: Hex
  leaves: Uint8Array
}): Promise<Record<string, unknown>> {
  const api = await BarretenbergSync.initSingleton()
  const hash: Hash = (left, right) => api.poseidon2Hash({ inputs: [left, right] }).hash
  const messageHash = hashMessage(ELIGIBILITY_SIGN_MESSAGE)
  const address = await recoverAddress({ hash: messageHash, signature: req.signature })
  const index = indexOf(req.leaves, leafOf(api, address))
  console.log(`[past-user] leaf index ${index}`, import.meta.env.DEV ? address : "")
  if (index < 0) throw new NotPastUserError("not a past zk.money user")
  const { root, siblings } = merklePath(req.leaves, index, hash)
  const publicKey = hexToBytes(
    await recoverPublicKey({ hash: messageHash, signature: req.signature }),
  )
  return {
    merkle_root: root,
    category: numberToHex(PAST_USER),
    owner: req.owner,
    address,
    signature: lowS(req.signature),
    pub_key_x: Array.from(publicKey.subarray(1, 33)),
    pub_key_y: Array.from(publicKey.subarray(33, 65)),
    message_hash: Array.from(hexToBytes(messageHash)),
    merkle_path: siblings,
    merkle_index_bits: siblings.map((_, level) => ((index >> level) & 1) === 1),
  }
}

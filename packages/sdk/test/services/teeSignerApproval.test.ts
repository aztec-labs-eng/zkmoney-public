import { describe, expect, it, vi } from "vitest"
import { PUBLIC_DATA_TREE_HEIGHT } from "@aztec/constants"
import { Fr } from "@aztec/aztec.js/fields"
import { Buffer32 } from "@aztec/foundation/buffer"
import { SiblingPath } from "@aztec/foundation/trees"
import { AztecAddress } from "@aztec/stdlib/aztec-address"
import { BlockHash } from "@aztec/stdlib/block"
import {
  PublicDataTreeLeaf,
  PublicDataTreeLeafPreimage,
  PublicDataWitness,
} from "@aztec/stdlib/trees"
import { ethAddressFromSecpPublicKey } from "@oxide/oxide-lib/attestation/user_data.js"
import { computeSignerApprovalLeafSlot } from "@oxide/oxide-lib/hash.js"
import type { SecpPublicKey, TeeSigner } from "@oxide/oxide-lib/types.js"
import {
  assertSigningKeyApproved,
  assertTeeSignerApproved,
  onTeeSignerRefused,
  TeeSignerNotApprovedError,
} from "../../src/services/teeSignerApproval.js"

const TOKEN = AztecAddress.fromStringUnsafe("0x" + "11".repeat(31) + "01")
const KEY: SecpPublicKey = { x: Buffer32.random(), y: Buffer32.random() }
const BLOCK = BlockHash.random()

function witness(slot: Fr, value: Fr): PublicDataWitness {
  const path = new SiblingPath(
    PUBLIC_DATA_TREE_HEIGHT,
    Array.from({ length: PUBLIC_DATA_TREE_HEIGHT }, () => Buffer.alloc(32)),
  )
  return new PublicDataWitness(
    7n,
    new PublicDataTreeLeafPreimage(new PublicDataTreeLeaf(slot, value), Fr.ZERO, 0n),
    path,
  )
}

function nodeReturning(w: PublicDataWitness | undefined) {
  return { getPublicDataWitness: vi.fn(async () => w) }
}

describe("assertTeeSignerApproved", () => {
  it("passes when the exact leaf slot holds 1, reading the witness at the given block", async () => {
    const slot = await computeSignerApprovalLeafSlot(TOKEN, KEY)
    const node = nodeReturning(witness(slot, new Fr(1)))

    await expect(
      assertTeeSignerApproved({ node, tokenAddress: TOKEN, publicKey: KEY, blockHash: BLOCK }),
    ).resolves.toBeUndefined()

    expect(node.getPublicDataWitness).toHaveBeenCalledTimes(1)
    const [block, requestedSlot] = node.getPublicDataWitness.mock.calls[0]! as unknown as [
      BlockHash,
      Fr,
    ]
    expect(block).toBe(BLOCK)
    expect(requestedSlot.equals(slot)).toBe(true)
  })

  it("throws a typed error naming the enclave on a low-leaf (never written) witness", async () => {
    const slot = await computeSignerApprovalLeafSlot(TOKEN, KEY)
    const lowLeafSlot = new Fr(slot.toBigInt() - 1n)
    const node = nodeReturning(witness(lowLeafSlot, new Fr(1)))

    const err = await assertTeeSignerApproved({
      node,
      tokenAddress: TOKEN,
      publicKey: KEY,
      blockHash: BLOCK,
    }).then(
      () => undefined,
      (e) => e,
    )

    expect(err).toBeInstanceOf(TeeSignerNotApprovedError)
    const typed = err as TeeSignerNotApprovedError
    const enclave = ethAddressFromSecpPublicKey(KEY)
    expect(typed.tokenAddress.equals(TOKEN)).toBe(true)
    expect(typed.enclaveAddress.equals(enclave)).toBe(true)
    expect(typed.publicKeyX).toBe(KEY.x.toString())
    expect(typed.message).toContain("not approved on token")
    expect(typed.message).toContain(enclave.toString())
  })

  it("throws when the exact slot holds 0 (registration consumed then cleared)", async () => {
    const slot = await computeSignerApprovalLeafSlot(TOKEN, KEY)
    const node = nodeReturning(witness(slot, Fr.ZERO))

    await expect(
      assertTeeSignerApproved({ node, tokenAddress: TOKEN, publicKey: KEY, blockHash: BLOCK }),
    ).rejects.toBeInstanceOf(TeeSignerNotApprovedError)
  })

  it("propagates a missing witness as the oxide-client error, not as a refusal", async () => {
    const node = nodeReturning(undefined)

    const err = await assertTeeSignerApproved({
      node,
      tokenAddress: TOKEN,
      publicKey: KEY,
      blockHash: BLOCK,
    }).then(
      () => undefined,
      (e) => e,
    )

    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(TeeSignerNotApprovedError)
    expect(String(err)).toMatch(/No public data witness/)
  })
})

describe("assertSigningKeyApproved", () => {
  function signerWith(key: SecpPublicKey) {
    const state = { keyReads: 0 }
    const signer = {
      get publicKey() {
        state.keyReads++
        return key
      },
    } as unknown as TeeSigner
    return { signer, state }
  }

  it("reads the signer's key once and returns it when approved; no listener is told", async () => {
    const slot = await computeSignerApprovalLeafSlot(TOKEN, KEY)
    const node = nodeReturning(witness(slot, new Fr(1)))
    const { signer, state } = signerWith(KEY)
    const refused = vi.fn()
    const off = onTeeSignerRefused(refused)
    try {
      await expect(
        assertSigningKeyApproved({ signer, node, tokenAddress: TOKEN, blockHash: BLOCK }),
      ).resolves.toBe(KEY)
    } finally {
      off()
    }
    expect(state.keyReads).toBe(1)
    expect(refused).not.toHaveBeenCalled()
  })

  it("tells the subscribed listeners which signer was refused, then throws the refusal", async () => {
    const slot = await computeSignerApprovalLeafSlot(TOKEN, KEY)
    const node = nodeReturning(witness(new Fr(slot.toBigInt() - 1n), new Fr(1)))
    const { signer } = signerWith(KEY)
    const told = vi.fn()
    const gone = vi.fn()
    const off = onTeeSignerRefused(told)
    onTeeSignerRefused(gone)()
    try {
      await expect(
        assertSigningKeyApproved({ signer, node, tokenAddress: TOKEN, blockHash: BLOCK }),
      ).rejects.toBeInstanceOf(TeeSignerNotApprovedError)
    } finally {
      off()
    }
    expect(told).toHaveBeenCalledTimes(1)
    const [refusedSigner, error] = told.mock.calls[0]!
    expect(refusedSigner).toBe(signer)
    expect(error).toBeInstanceOf(TeeSignerNotApprovedError)
    expect(gone).not.toHaveBeenCalled()
  })

  it("still tells later listeners and throws the refusal when a listener throws", async () => {
    const slot = await computeSignerApprovalLeafSlot(TOKEN, KEY)
    const node = nodeReturning(witness(new Fr(slot.toBigInt() - 1n), new Fr(1)))
    const { signer } = signerWith(KEY)
    const faulty = vi.fn(() => {
      throw new Error("listener bug")
    })
    const later = vi.fn()
    const offFaulty = onTeeSignerRefused(faulty)
    const offLater = onTeeSignerRefused(later)
    try {
      await expect(
        assertSigningKeyApproved({ signer, node, tokenAddress: TOKEN, blockHash: BLOCK }),
      ).rejects.toBeInstanceOf(TeeSignerNotApprovedError)
    } finally {
      offFaulty()
      offLater()
    }
    expect(faulty).toHaveBeenCalledTimes(1)
    expect(later).toHaveBeenCalledTimes(1)
    expect(later.mock.calls[0]![0]).toBe(signer)
  })

  it("propagates a missing witness without telling any listener", async () => {
    const node = nodeReturning(undefined)
    const { signer } = signerWith(KEY)
    const refused = vi.fn()
    const off = onTeeSignerRefused(refused)
    try {
      await expect(
        assertSigningKeyApproved({ signer, node, tokenAddress: TOKEN, blockHash: BLOCK }),
      ).rejects.not.toBeInstanceOf(TeeSignerNotApprovedError)
    } finally {
      off()
    }
    expect(refused).not.toHaveBeenCalled()
  })
})

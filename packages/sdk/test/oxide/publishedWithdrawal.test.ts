import { Buffer32 } from "@aztec/foundation/buffer"
import { sha256 } from "@aztec/foundation/crypto/sha256"
import { Fr } from "@aztec/foundation/curves/bn254"
import { EthAddress } from "@aztec/foundation/eth-address"
import { AztecAddress } from "@aztec/stdlib/aztec-address"
import { BlockHash } from "@aztec/stdlib/block"
import type { AztecNode } from "@aztec/stdlib/interfaces/client"
import { SiloedTag, Tag } from "@aztec/stdlib/logs"
import { TxHash } from "@aztec/stdlib/tx"
import { getUserPayloadHash } from "@oxide/oxide-lib/content_hash.js"
import { computeWithdrawMessageHash } from "@oxide/oxide-lib/hash.js"
import {
  TEE_METADATA_DA_TAG,
  WITHDRAWAL_PUBLISHING_TAG,
} from "@oxide/oxide-lib/oxide_constants.gen.js"
import { encodePlainWithdrawalPayload } from "@oxide/oxide-lib/plain_withdrawal.js"
import type { OutboxWithdrawal, PortalContext } from "@oxide/oxide-lib/types.js"
import type { Hex } from "viem"
import { describe, expect, it } from "vitest"

import {
  type WithdrawalPortalContext,
  computeWithdrawalId,
  fetchWithdrawalsWithIds,
} from "../../src/oxide/publishedWithdrawal.js"

const L1_PORTAL = ("0x" + "22".repeat(20)) as Hex
const L2_PORTAL = "0x" + "03".repeat(32)
const ROLLUP_VERSION = 3n
const L1_CHAIN_ID = 11155111n

const CTX: WithdrawalPortalContext = {
  l1Portal: L1_PORTAL,
  l2Portal: L2_PORTAL,
  rollupVersion: ROLLUP_VERSION,
  l1ChainId: L1_CHAIN_ID,
}

const TX_HASH = TxHash.fromString("0x" + "11".repeat(32))
const EXECUTOR = EthAddress.fromString("0x" + "e0".repeat(20))
const RECIPIENT = EthAddress.fromString("0x" + "44".repeat(20))
const RELAYER_TIP = 3n * 10n ** 17n

function makeWithdrawal(overrides: Partial<OutboxWithdrawal> = {}): OutboxWithdrawal {
  return {
    executor: EXECUTOR,
    userPayloadHash: getUserPayloadHash(
      encodePlainWithdrawalPayload({ recipient: RECIPIENT, relayerTip: RELAYER_TIP }),
    ),
    amount: 1_000_000n,
    proverTip: 0n,
    randomness: new Fr(0xdeadbeefn),
    ...overrides,
  }
}

/** Independent reconstruction mirroring the enclave (byte concat of the two buffers). */
function expectedId(ctx: PortalContext, txHash: TxHash, w: OutboxWithdrawal): Buffer32 {
  const messageHash = computeWithdrawMessageHash(ctx, w)
  return new Buffer32(sha256(Buffer.concat([txHash.toBuffer(), messageHash.toBuffer()])))
}

describe("computeWithdrawalId", () => {
  const oxideCtx: PortalContext = {
    l1Portal: EthAddress.fromString(L1_PORTAL),
    l2Portal: AztecAddress.fromStringUnsafe(L2_PORTAL),
    rollupVersion: ROLLUP_VERSION,
    l1ChainId: L1_CHAIN_ID,
  }

  it("matches the enclave byte-vector (byte concat of txHash + messageHash buffers)", () => {
    const w = makeWithdrawal()
    const { withdrawalId } = computeWithdrawalId(CTX, TX_HASH, w)
    expect(withdrawalId.equals(expectedId(oxideCtx, TX_HASH, w))).toBe(true)
  })

  it("differs from a hex-string (ASCII) concat — pins byte concat, not string concat", () => {
    const w = makeWithdrawal()
    const { messageHash, withdrawalId } = computeWithdrawalId(CTX, TX_HASH, w)
    const asciiConcatId = new Buffer32(
      sha256(Buffer.concat([Buffer.from(TX_HASH.toString()), Buffer.from(messageHash.toString())])),
    )
    expect(withdrawalId.equals(asciiConcatId)).toBe(false)
  })

  it("changes when l2Portal changes — pins the l2Portal mapping (tuple.l2Token)", () => {
    const w = makeWithdrawal()
    const correct = computeWithdrawalId(CTX, TX_HASH, w).withdrawalId
    const wrongL2 = computeWithdrawalId(
      { ...CTX, l2Portal: "0x" + "05".repeat(32) },
      TX_HASH,
      w,
    ).withdrawalId
    expect(correct.equals(wrongL2)).toBe(false)
  })

  it("changes with the executor and the user payload the burn commits to", () => {
    const w = makeWithdrawal()
    const correct = computeWithdrawalId(CTX, TX_HASH, w).withdrawalId
    const otherExecutor = makeWithdrawal({
      executor: EthAddress.fromString("0x" + "e1".repeat(20)),
    })
    const otherPayload = makeWithdrawal({ userPayloadHash: new Fr(1n) })
    expect(correct.equals(computeWithdrawalId(CTX, TX_HASH, otherExecutor).withdrawalId)).toBe(
      false,
    )
    expect(correct.equals(computeWithdrawalId(CTX, TX_HASH, otherPayload).withdrawalId)).toBe(false)
  })

  it("changes when l1ChainId or rollupVersion changes — pins the rest of the mapping", () => {
    const w = makeWithdrawal()
    const correct = computeWithdrawalId(CTX, TX_HASH, w).withdrawalId
    expect(
      correct.equals(computeWithdrawalId({ ...CTX, l1ChainId: 1n }, TX_HASH, w).withdrawalId),
    ).toBe(false)
    expect(
      correct.equals(computeWithdrawalId({ ...CTX, rollupVersion: 99n }, TX_HASH, w).withdrawalId),
    ).toBe(false)
  })
})

describe("fetchWithdrawalsWithIds", () => {
  const ANCHOR = new Fr(0xabcn)

  // Both extractors match on fields[0] being the tag SILOED with the emitting contract, and read
  // the payload from fields[1]. A raw (unsiloed) tag matches nothing.
  async function siloed(rawTag: bigint): Promise<Fr> {
    const tag = await SiloedTag.computeFromTagAndApp(
      new Tag(new Fr(rawTag)),
      AztecAddress.fromStringUnsafe(L2_PORTAL),
    )
    return tag.value
  }

  async function metadataLog() {
    // fields: [siloed DA tag, xHi, xLo, yHi, yLo, anchorBlockHash]
    return {
      fields: [
        await siloed(TEE_METADATA_DA_TAG),
        new Fr(1),
        new Fr(2),
        new Fr(3),
        new Fr(4),
        ANCHOR,
      ],
      emittedLength: 6,
    }
  }

  async function withdrawalLog(w: OutboxWithdrawal) {
    // FieldReader layout consumed by extractWithdrawalMessages: skip the siloed tag, then
    // executor, userPayloadHash, amount, proverTip, randomness, recipient, relayerTip, signature
    // (sLo, sHi, rLo, rHi).
    return {
      fields: [
        await siloed(WITHDRAWAL_PUBLISHING_TAG),
        w.executor.toField(),
        w.userPayloadHash,
        new Fr(w.amount),
        new Fr(w.proverTip),
        w.randomness,
        RECIPIENT.toField(),
        new Fr(RELAYER_TIP),
        new Fr(7),
        new Fr(8),
        new Fr(9),
        new Fr(10),
      ],
      emittedLength: 12,
    }
  }

  function nodeReturning(privateLogs: unknown[]): AztecNode {
    return {
      getTxEffect: async () => ({ data: { privateLogs } }),
    } as unknown as AztecNode
  }

  it("throws (retryable) when the burn tx effect is not yet indexed", async () => {
    const node = { getTxEffect: async () => undefined } as unknown as AztecNode
    await expect(fetchWithdrawalsWithIds(node, TX_HASH, CTX)).rejects.toThrow(/Tx effect not found/)
  })

  it("returns an empty list (not a throw) when the effect carries no withdrawal log", async () => {
    const node = nodeReturning([await metadataLog()])
    const res = await fetchWithdrawalsWithIds(node, TX_HASH, CTX)
    expect(res.withdrawals).toEqual([])
    expect(res.anchorBlockHash.toString()).toBe(new BlockHash(ANCHOR).toString())
  })

  it("ignores a raw (unsiloed) DA tag — only the contract-siloed tag counts", async () => {
    // Guards the fixtures above: a raw-tagged log matches nothing, so building fixtures with the
    // unsiloed constant would make every assertion here vacuous rather than fail loudly.
    const raw = { ...(await metadataLog()), fields: [new Fr(TEE_METADATA_DA_TAG)] }
    const node = nodeReturning([raw])
    await expect(fetchWithdrawalsWithIds(node, TX_HASH, CTX)).rejects.toThrow(
      /Expected exactly one DA component/,
    )
  })

  it("decodes a published withdrawal and derives a withdrawalId consistent with the pure helper", async () => {
    const w = makeWithdrawal({ amount: 2_500_000n, proverTip: 5n, randomness: new Fr(0x1234n) })
    const node = nodeReturning([await metadataLog(), await withdrawalLog(w)])

    const res = await fetchWithdrawalsWithIds(node, TX_HASH, CTX)
    expect(res.withdrawals).toHaveLength(1)

    const decoded = res.withdrawals[0]!
    expect(decoded.executor.equals(EXECUTOR)).toBe(true)
    expect(decoded.userPayloadHash.equals(w.userPayloadHash)).toBe(true)
    expect(decoded.amount).toBe(w.amount)
    expect(decoded.proverTip).toBe(5n)
    expect(decoded.randomness.equals(w.randomness)).toBe(true)
    expect(decoded.recipient.equals(RECIPIENT)).toBe(true)
    expect(decoded.relayerTip).toBe(RELAYER_TIP)
    expect(decoded.signature).toEqual({
      sLo: new Fr(7),
      sHi: new Fr(8),
      rLo: new Fr(9),
      rHi: new Fr(10),
    })

    // The wrapper's derived id must equal re-deriving from the decoded fields.
    expect(
      decoded.withdrawalId.equals(computeWithdrawalId(CTX, TX_HASH, decoded).withdrawalId),
    ).toBe(true)
  })

  it("refuses a withdrawal log short of its twelve fields", async () => {
    const log = await withdrawalLog(makeWithdrawal())
    const node = nodeReturning([
      await metadataLog(),
      { fields: log.fields.slice(0, 10), emittedLength: 10 },
    ])
    await expect(fetchWithdrawalsWithIds(node, TX_HASH, CTX)).rejects.toThrow(
      /Failed to decode withdrawalPublishing log/,
    )
  })
})

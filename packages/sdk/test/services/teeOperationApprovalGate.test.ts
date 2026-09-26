import { beforeEach, describe, expect, it, vi } from "vitest"
import { PUBLIC_DATA_TREE_HEIGHT } from "@aztec/constants"
import { Fr } from "@aztec/aztec.js/fields"
import { Buffer32 } from "@aztec/foundation/buffer"
import { EthAddress } from "@aztec/foundation/eth-address"
import { SiblingPath } from "@aztec/foundation/trees"
import { AztecAddress } from "@aztec/stdlib/aztec-address"
import { BlockHash } from "@aztec/stdlib/block"
import {
  PublicDataTreeLeaf,
  PublicDataTreeLeafPreimage,
  PublicDataWitness,
} from "@aztec/stdlib/trees"
import { computeSignerApprovalLeafSlot } from "@oxide/oxide-lib/hash.js"
import { encodePlainWithdrawalPayload } from "@oxide/oxide-lib/plain_withdrawal.js"
import { TEEMetadata, type SecpPublicKey } from "@oxide/oxide-lib/types.js"

// The finalizer's collaborators are stubbed at the module seams the finalizer imports; the gate
// itself (`assertTeeSignerApproved`) runs for real against a stubbed public-data witness.
const { batchCalls, capsules } = vi.hoisted(() => ({
  batchCalls: [] as { calls: unknown[] }[],
  capsules: {
    buildNoteSignatureCapsule: vi.fn(async () => "sig-capsule"),
    buildPlainExecutorUserPayloadCapsules: vi.fn(async () => [] as unknown[]),
    buildSeedCapsule: vi.fn(() => "seed-capsule"),
    buildStrictModeCapsule: vi.fn(() => "strict-capsule"),
    buildTeeMetadataCapsule: vi.fn(() => "meta-capsule"),
    buildTeeNotesCapsule: vi.fn(() => "notes-capsule"),
    buildTeeRequiredNullifiersCapsule: vi.fn(() => "nullifiers-capsule"),
    buildTeeWithdrawalMessageHashesCapsule: vi.fn(() => "wmh-capsule"),
    buildWithdrawalSignatureCapsule: vi.fn(async () => "wsig-capsule"),
  },
}))

vi.mock("@oxide/oxide-client/capsules.js", () => capsules)

vi.mock("@oxide/oxide-client/signer_approval.js", () => ({
  fetchSignerApprovalWitness: vi.fn(),
}))

vi.mock("../../src/oxide/index.js", () => ({
  collectAccountingEffects: vi.fn(() => ({
    deposits: [],
    nullifiedNotes: [],
    squashedTransientNotes: [],
    withdrawals: [],
  })),
  buildTokenOperation: vi.fn(),
}))

vi.mock("@aztec/aztec.js/contracts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aztec/aztec.js/contracts")>()
  class FakeBatchCall {
    request = vi.fn(async () => ({ feePayer: "payer" }))
    constructor(_wallet: unknown, readonly calls: unknown[]) {
      batchCalls.push(this)
    }
  }
  return { ...actual, BatchCall: FakeBatchCall }
})

import { fetchSignerApprovalWitness } from "@oxide/oxide-client/signer_approval.js"
import { buildTokenOperation } from "../../src/oxide/index.js"
import { buildTeeOperation } from "../../src/services/teeOperation.js"
import {
  onTeeSignerRefused,
  TeeSignerNotApprovedError,
} from "../../src/services/teeSignerApproval.js"

const TOKEN = AztecAddress.fromStringUnsafe("0x" + "11".repeat(31) + "01")
const SENDER = AztecAddress.fromStringUnsafe("0x" + "22".repeat(31) + "02")
const KEY: SecpPublicKey = { x: Buffer32.random(), y: Buffer32.random() }
const ANCHOR = BlockHash.random()
const anchorHeader = { hash: async () => ANCHOR }

function witness(slot: Fr, value: Fr): PublicDataWitness {
  const path = new SiblingPath(
    PUBLIC_DATA_TREE_HEIGHT,
    Array.from({ length: PUBLIC_DATA_TREE_HEIGHT }, () => Buffer.alloc(32)),
  )
  return new PublicDataWitness(
    1n,
    new PublicDataTreeLeafPreimage(new PublicDataTreeLeaf(slot, value), Fr.ZERO, 0n),
    path,
  )
}

function makeSigner() {
  const state = { keyReads: 0, keyReadsAtSign: -1 }
  const signer = {
    get publicKey() {
      state.keyReads++
      return KEY
    },
    ethAddress: EthAddress.random(),
    signTokenOperation: vi.fn(async () => {
      state.keyReadsAtSign = state.keyReads
      return {
        signatures: [],
        withdrawalSignatures: [],
        requiredNullifiers: [],
        teeNotes: [],
        withdrawalMessageHashes: [],
      }
    }),
  }
  return { signer, state }
}

async function buildAndFinalize(
  signer: ReturnType<typeof makeSigner>["signer"],
  over: Record<string, unknown> = {},
) {
  const publishDa = vi.fn(() => ({ with: vi.fn(() => "publish_da-call") }))
  const tokenContract = { address: TOKEN, methods: { publish_da: publishDa } }
  const node = { getPublicDataWitness: vi.fn() }
  const buildOperationCall = vi.fn((_op: unknown, _capsules: unknown[]) => "op-call" as never)
  const built = await buildTeeOperation({ wallet: {}, node } as never, SENDER, {
    tokenContract: tokenContract as never,
    signer: signer as never,
    operations: [{ kind: "transfer" } as never],
    buildOperationCall,
    ...over,
  })
  const simResult = {
    publicInputs: { constants: { anchorBlockHeader: anchorHeader } },
    offchainEffects: [],
  }
  const outcome = await built.sendOpts.finalize(simResult as never).then(
    (payload) => ({ payload, error: undefined }),
    (error: unknown) => ({ payload: undefined, error }),
  )
  return { ...outcome, publishDa, buildOperationCall }
}

describe("buildTeeOperation approval gate", () => {
  beforeEach(() => {
    batchCalls.length = 0
    for (const fn of Object.values(capsules)) fn.mockClear()
    vi.mocked(buildTokenOperation).mockResolvedValue({
      createdNotes: [],
      withdrawals: [],
      anchorBlockHeader: anchorHeader,
    } as never)
  })

  it("aborts before any signature capsule or production batch when the signing key is unapproved", async () => {
    const slot = await computeSignerApprovalLeafSlot(TOKEN, KEY)
    vi.mocked(fetchSignerApprovalWitness).mockResolvedValue(
      witness(new Fr(slot.toBigInt() - 1n), new Fr(1)),
    )
    const { signer } = makeSigner()

    const { error, publishDa } = await buildAndFinalize(signer)

    expect(error).toBeInstanceOf(TeeSignerNotApprovedError)
    expect(signer.signTokenOperation).toHaveBeenCalledTimes(1)
    expect(capsules.buildNoteSignatureCapsule).not.toHaveBeenCalled()
    expect(capsules.buildTeeMetadataCapsule).not.toHaveBeenCalled()
    expect(publishDa).not.toHaveBeenCalled()
    // Only the simulation-shape batch exists; the production batch was never assembled.
    expect(batchCalls).toHaveLength(1)
    expect(batchCalls[0]!.calls).toEqual(["op-call"])
  })

  it("tells the signer's owner about the refusal before rejecting", async () => {
    const slot = await computeSignerApprovalLeafSlot(TOKEN, KEY)
    vi.mocked(fetchSignerApprovalWitness).mockResolvedValue(
      witness(new Fr(slot.toBigInt() - 1n), new Fr(1)),
    )
    const { signer } = makeSigner()
    const refused = vi.fn()
    const off = onTeeSignerRefused(refused)
    try {
      const { error } = await buildAndFinalize(signer)
      expect(error).toBeInstanceOf(TeeSignerNotApprovedError)
      expect(refused).toHaveBeenCalledTimes(1)
      expect(refused).toHaveBeenCalledWith(signer, error)
    } finally {
      off()
    }
  })

  it("checks the key at the operation anchor and reads it exactly once, after signing", async () => {
    const slot = await computeSignerApprovalLeafSlot(TOKEN, KEY)
    vi.mocked(fetchSignerApprovalWitness).mockResolvedValue(witness(slot, new Fr(1)))
    const { signer, state } = makeSigner()

    const { error, payload } = await buildAndFinalize(signer)

    expect(error).toBeUndefined()
    expect(payload).toBeDefined()
    expect(state.keyReadsAtSign).toBe(0)
    expect(state.keyReads).toBe(1)

    const [, token, key, block] = vi.mocked(fetchSignerApprovalWitness).mock.calls[0]!
    expect((token as AztecAddress).equals(TOKEN)).toBe(true)
    expect(key).toBe(KEY)
    expect(block).toBe(ANCHOR)

    // The metadata capsule carries the same key the gate checked.
    const [, metadata] = capsules.buildTeeMetadataCapsule.mock.calls[0]! as unknown as [
      AztecAddress,
      TEEMetadata,
    ]
    expect(metadata.publicKey().x.equals(KEY.x)).toBe(true)
    expect(metadata.publicKey().y.equals(KEY.y)).toBe(true)
    expect(batchCalls).toHaveLength(2)
  })
})

describe("buildTeeOperation plain withdrawals", () => {
  const EXECUTOR = EthAddress.fromNumber(0xe0)
  const USER_PAYLOAD = encodePlainWithdrawalPayload({
    recipient: EthAddress.fromNumber(0xa1),
    relayerTip: 10n,
  })
  const withdrawOp = {
    kind: "withdraw",
    from: SENDER,
    executor: EXECUTOR,
    userPayload: USER_PAYLOAD,
    amount: 1_000n,
    proverTip: 0n,
  }
  const plainWithdrawal = { executor: EXECUTOR, fpcFundingCut: 0n, frozen: false }
  const burn = { burn: 1 }

  beforeEach(async () => {
    batchCalls.length = 0
    for (const fn of Object.values(capsules)) fn.mockClear()
    vi.mocked(buildTokenOperation).mockResolvedValue({
      createdNotes: [],
      withdrawals: [burn],
      anchorBlockHeader: anchorHeader,
    } as never)
    const slot = await computeSignerApprovalLeafSlot(TOKEN, KEY)
    vi.mocked(fetchSignerApprovalWitness).mockResolvedValue(witness(slot, new Fr(1)))
  })

  it("refuses a withdrawal without the deployment's plain withdrawal executor", async () => {
    await expect(
      buildAndFinalize(makeSigner().signer, { operations: [withdrawOp] }),
    ).rejects.toThrow(/needs the deployment's plain withdrawal executor/)
    expect(batchCalls).toHaveLength(0)
  })

  it("refuses a relayer tip the executor's share after the funding cut cannot pay", async () => {
    await expect(
      buildAndFinalize(makeSigner().signer, {
        operations: [withdrawOp],
        plainWithdrawal: { ...plainWithdrawal, fpcFundingCut: 995n },
      }),
    ).rejects.toThrow(/relayer tip 10 exceeds executor amount 5/)
    expect(batchCalls).toHaveLength(0)
  })

  it("publishes each declared user payload to the production call", async () => {
    capsules.buildPlainExecutorUserPayloadCapsules.mockResolvedValueOnce(["payload-capsule"])

    const { error, buildOperationCall } = await buildAndFinalize(makeSigner().signer, {
      operations: [withdrawOp],
      plainWithdrawal,
    })

    expect(error).toBeUndefined()
    const [token, withdrawals, payloads, executor] = capsules.buildPlainExecutorUserPayloadCapsules
      .mock.calls[0]! as unknown as [AztecAddress, unknown[], Buffer[], EthAddress]
    expect(token.equals(TOKEN)).toBe(true)
    expect(withdrawals).toEqual([burn])
    expect(payloads).toEqual([USER_PAYLOAD])
    expect(executor).toBe(EXECUTOR)
    // Sim call first (seed only), then the production call carrying the payload capsule last.
    expect(buildOperationCall).toHaveBeenCalledTimes(2)
    expect(buildOperationCall.mock.calls[1]![1].at(-1)).toBe("payload-capsule")
  })

  it("refuses a batch that withdraws without declaring its user payloads", async () => {
    const { error } = await buildAndFinalize(makeSigner().signer)

    expect((error as Error).message).toMatch(/withdraws without declaring its user payloads/)
    expect(capsules.buildPlainExecutorUserPayloadCapsules).not.toHaveBeenCalled()
    expect(batchCalls).toHaveLength(1)
  })
})

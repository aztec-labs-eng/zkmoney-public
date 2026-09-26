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
import { TEEMetadata, type SecpPublicKey } from "@oxide/oxide-lib/types.js"

// Same seams as the account-entrypoint gate test; the sponsored payload builders are stubbed so the
// test can count how many FPC payloads the finalizer assembles. Capsule stubs carry the
// (contract, slot) key the finalizer dedupes on.
const { capsules, sponsoredPayloads } = vi.hoisted(() => ({
  sponsoredPayloads: [] as { innerCalls: unknown[] }[],
  capsules: {
    buildNoteSignatureCapsule: vi.fn(async () => "sig-capsule"),
    buildPlainExecutorUserPayloadCapsules: vi.fn(async () => [] as unknown[]),
    buildSeedCapsule: vi.fn(() => ({ contractAddress: "token", storageSlot: "seed" })),
    buildStrictModeCapsule: vi.fn(() => ({ contractAddress: "token", storageSlot: "strict" })),
    buildTeeMetadataCapsule: vi.fn(() => ({ contractAddress: "token", storageSlot: "meta" })),
    buildTeeNotesCapsule: vi.fn(() => ({ contractAddress: "token", storageSlot: "notes" })),
    buildTeeRequiredNullifiersCapsule: vi.fn(() => ({
      contractAddress: "token",
      storageSlot: "nullifiers",
    })),
    buildTeeWithdrawalMessageHashesCapsule: vi.fn(() => ({
      contractAddress: "token",
      storageSlot: "wmh",
    })),
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

vi.mock("../../src/feePaymentMethod/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/feePaymentMethod/index.js")>()
  return {
    ...actual,
    buildClaimSponsorPayload: vi.fn(async (opts: { innerCalls: unknown[] }) => {
      sponsoredPayloads.push({ innerCalls: opts.innerCalls })
      return "sponsored-payload"
    }),
    buildClaimSubscribePayload: vi.fn(),
    claimFpcSponsoredFee: vi.fn(() => "fee"),
  }
})

import { fetchSignerApprovalWitness } from "@oxide/oxide-client/signer_approval.js"
import { buildTokenOperation } from "../../src/oxide/index.js"
import { buildSponsoredTeeOperation } from "../../src/services/sponsoredTeeOperation.js"
import {
  onTeeSignerRefused,
  TeeSignerNotApprovedError,
} from "../../src/services/teeSignerApproval.js"

const TOKEN = AztecAddress.fromStringUnsafe("0x" + "11".repeat(31) + "01")
const USER = AztecAddress.fromStringUnsafe("0x" + "22".repeat(31) + "02")
const FPC = AztecAddress.fromStringUnsafe("0x" + "03".repeat(31) + "03")
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

/** An interaction as `toCallAndCapsules` reads it: one call plus the capsules `.with()` attached. */
const interaction = (name: string, capsules: unknown[] = []) => ({
  request: async () => ({ calls: [name], capsules }),
})

async function buildAndFinalize(signer: ReturnType<typeof makeSigner>["signer"]) {
  const publishDa = vi.fn(() => ({
    with: vi.fn(({ capsules }: { capsules: unknown[] }) => interaction("publish_da", capsules)),
  }))
  const tokenContract = { address: TOKEN, methods: { publish_da: publishDa } }
  const node = { getPublicDataWitness: vi.fn() }
  const built = await buildSponsoredTeeOperation({ wallet: {}, node } as never, {
    fpcAddress: FPC,
    fpcArtifact: {} as never,
    railId: 0,
    policy: {} as never,
    user: USER,
    tokenContract: tokenContract as never,
    signer: signer as never,
    operations: [{ kind: "transfer" } as never],
    buildOperationCall: vi.fn(() => interaction("op-call") as never),
    operationClassWitnesses: [undefined],
  })
  const simResult = {
    publicInputs: { constants: { anchorBlockHeader: anchorHeader } },
    offchainEffects: [],
  }
  const outcome = await built.sendOpts.finalize(simResult as never).then(
    (payload) => ({ payload, error: undefined }),
    (error: unknown) => ({ payload: undefined, error }),
  )
  return { ...outcome, publishDa }
}

describe("buildSponsoredTeeOperation approval gate", () => {
  beforeEach(() => {
    sponsoredPayloads.length = 0
    for (const fn of Object.values(capsules)) fn.mockClear()
    vi.mocked(buildTokenOperation).mockResolvedValue({
      createdNotes: [],
      withdrawals: [],
      anchorBlockHeader: anchorHeader,
    } as never)
  })

  it("aborts before any signature capsule or finalized FPC payload when the signing key is unapproved", async () => {
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
    // Only the simulation-shape payload exists; the finalized payload was never assembled.
    expect(sponsoredPayloads).toHaveLength(1)
    expect(sponsoredPayloads[0]!.innerCalls).toEqual(["op-call"])
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
    expect(sponsoredPayloads).toHaveLength(2)
    expect(sponsoredPayloads[1]!.innerCalls).toEqual(["op-call", "publish_da"])
  })

  it("refuses a batch that withdraws without declaring its user payloads", async () => {
    const slot = await computeSignerApprovalLeafSlot(TOKEN, KEY)
    vi.mocked(fetchSignerApprovalWitness).mockResolvedValue(witness(slot, new Fr(1)))
    vi.mocked(buildTokenOperation).mockResolvedValue({
      createdNotes: [],
      withdrawals: [{ burn: 1 }],
      anchorBlockHeader: anchorHeader,
    } as never)

    const { error } = await buildAndFinalize(makeSigner().signer)

    expect((error as Error).message).toMatch(/withdraws without declaring its user payloads/)
    expect(capsules.buildPlainExecutorUserPayloadCapsules).not.toHaveBeenCalled()
    expect(sponsoredPayloads).toHaveLength(1)
  })
})

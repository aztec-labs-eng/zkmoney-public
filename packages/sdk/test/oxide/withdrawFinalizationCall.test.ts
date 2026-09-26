/**
 * The self-finalize call builder, off-chain. The node-replay collaborators (archive resolution,
 * ancestry hints, signer approval, DA metadata) are mocked — they say nothing about the calldata —
 * while the published-log decoding, the user payload recovery, oxide-client's portal calldata and
 * the failure classification run for real. The call is decoded back with `OxidePortalAbi`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { decodeFunctionData, getAddress, type Hex, type PublicClient } from "viem"
import { Fr } from "@aztec/aztec.js/fields"
import { EthAddress } from "@aztec/foundation/eth-address"
import { AztecAddress } from "@aztec/stdlib/aztec-address"
import { SiloedTag, Tag } from "@aztec/stdlib/logs"
import { TxHash } from "@aztec/stdlib/tx"
import { OxidePortalAbi } from "@oxide/l1-contracts"
import { EnclaveUnavailable } from "@oxide/oxide-client/errors.js"
import { getUserPayloadHash } from "@oxide/oxide-lib/content_hash.js"
import { WITHDRAWAL_PUBLISHING_TAG } from "@oxide/oxide-lib/oxide_constants.gen.js"
import {
  decodePlainRelayerPayload,
  decodePlainWithdrawalPayload,
  encodePlainWithdrawalPayload,
} from "@oxide/oxide-lib/plain_withdrawal.js"

import { computeWithdrawalId } from "../../src/oxide/publishedWithdrawal.js"

const mocks = vi.hoisted(() => ({
  resolveArchive: vi.fn(),
  resolveBurnCheckpointArchive: vi.fn(),
  produceArchivedTxEffectsHints: vi.fn(),
  fetchSignerApprovalWitness: vi.fn(),
  extractMetadata: vi.fn(),
}))

vi.mock("@oxide/oxide-client/archive_ref.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveArchive: mocks.resolveArchive,
  resolveBurnCheckpointArchive: mocks.resolveBurnCheckpointArchive,
}))
vi.mock("@oxide/oxide-client/produce_tx_effects_hints.js", () => ({
  produceArchivedTxEffectsHints: mocks.produceArchivedTxEffectsHints,
}))
vi.mock("@oxide/oxide-client/signer_approval.js", () => ({
  fetchSignerApprovalWitness: mocks.fetchSignerApprovalWitness,
}))
vi.mock("@oxide/oxide-lib/da_extractors.js", () => ({ extractMetadata: mocks.extractMetadata }))

const { buildWithdrawFinalizationCall, WithdrawFinalizationError } = await import(
  "../../src/oxide/withdrawFinalizationCall.js"
)

const PORTAL = ("0x" + "11".repeat(20)) as Hex
const EXECUTOR = ("0x" + "e0".repeat(20)) as Hex
const RECIPIENT = ("0x" + "44".repeat(20)) as Hex
const TIP_RECIPIENT = ("0x" + "7a".repeat(20)) as Hex
const WITHDRAWAL_SUBSIDY = ("0x" + "5b".repeat(20)) as Hex
const BURN_TX = ("0x" + "0a".repeat(32)) as Hex
const TEE_SIGNATURE = ("0x" + "5e".repeat(65)) as Hex

const PORTAL_CONTEXT = {
  l1Portal: PORTAL,
  l2Portal: "0x" + "0b".repeat(32),
  rollupVersion: 3n,
  l1ChainId: 11155111n,
}

const AMOUNT = 1_234_000_000_000_000_000n
const PROVER_TIP = 7n
const RELAYER_TIP = 100_000_000_000_000_000n
const RANDOMNESS = new Fr(0x1234n)
const SIGNATURE = { sLo: new Fr(1n), sHi: new Fr(2n), rLo: new Fr(3n), rHi: new Fr(4n) }
const ANCHOR_BLOCK_HASH = { toString: () => "anchor" }
const ARCHIVE_ROOT = new Fr(0xa11cen)
const SIBLING_PATH = [new Fr(1n), new Fr(2n), new Fr(3n)]

const OUTBOX_WITNESS = {
  epochNumber: 9,
  numCheckpointsInEpoch: 4,
  leafIndex: 6n,
  siblingPath: { toFields: () => SIBLING_PATH },
}

const USER_PAYLOAD = encodePlainWithdrawalPayload({
  recipient: EthAddress.fromString(RECIPIENT),
  relayerTip: RELAYER_TIP,
})

/** What the burn published, and the withdrawal the portal context derives from it. */
const PUBLISHED = {
  executor: EthAddress.fromString(EXECUTOR),
  userPayloadHash: getUserPayloadHash(USER_PAYLOAD),
  amount: AMOUNT,
  proverTip: PROVER_TIP,
  randomness: RANDOMNESS,
}
const { messageHash: MESSAGE_HASH, withdrawalId: WITHDRAWAL_ID } = computeWithdrawalId(
  PORTAL_CONTEXT,
  TxHash.fromString(BURN_TX),
  PUBLISHED,
)

/** The `publish_withdrawal` log: the siloed tag, then the twelve-field layout's remaining fields. */
async function withdrawalLog(published: { recipient?: Hex } = {}) {
  const tag = await SiloedTag.computeFromTagAndApp(
    new Tag(new Fr(WITHDRAWAL_PUBLISHING_TAG)),
    AztecAddress.fromStringUnsafe(PORTAL_CONTEXT.l2Portal),
  )
  return {
    fields: [
      tag.value,
      PUBLISHED.executor.toField(),
      PUBLISHED.userPayloadHash,
      new Fr(AMOUNT),
      new Fr(PROVER_TIP),
      RANDOMNESS,
      EthAddress.fromString(published.recipient ?? RECIPIENT).toField(),
      new Fr(RELAYER_TIP),
      SIGNATURE.sLo,
      SIGNATURE.sHi,
      SIGNATURE.rLo,
      SIGNATURE.rHi,
    ],
    emittedLength: 12,
  }
}

function enclaveOutput() {
  return { withdrawalId: WITHDRAWAL_ID, signature: { toString: () => TEE_SIGNATURE } }
}

interface ScenarioOptions {
  /** Absent means the outbox has no covering root yet. */
  witness?: unknown
  spent?: boolean
  signs?: () => Promise<unknown>
  executor?: Hex
  publishedRecipient?: Hex
}

async function scenario(options: ScenarioOptions = {}) {
  const log = await withdrawalLog({ recipient: options.publishedRecipient })
  const node = {
    getTxEffect: vi.fn(async () => ({ data: { privateLogs: [log], txHash: BURN_TX } })),
    getL2ToL1MembershipWitness: vi.fn(async () =>
      "witness" in options ? options.witness : OUTBOX_WITNESS,
    ),
    getBlockHashMembershipWitness: vi.fn(async () => ({ leafIndex: 0n })),
  }
  const signer = {
    signWithdrawalFinalization: vi.fn(options.signs ?? (async () => enclaveOutput())),
  }
  const l1 = { readContract: vi.fn(async () => options.spent ?? false) }
  return {
    node,
    signer,
    l1,
    deps: {
      node: node as never,
      signer: signer as never,
      portalContext: PORTAL_CONTEXT,
      plainWithdrawalExecutor: options.executor ?? EXECUTOR,
      l1: l1 as unknown as PublicClient,
    },
  }
}

const ARGS = { burnTxHash: BURN_TX, tipRecipient: TIP_RECIPIENT }

function decodeWithdraw(data: Hex) {
  const decoded = decodeFunctionData({ abi: OxidePortalAbi, data })
  expect(decoded.functionName).toBe("withdraw")
  return (decoded.args as readonly [Record<string, unknown>])[0]
}

const hex = (bytes: Buffer) => `0x${bytes.toString("hex")}`

beforeEach(() => {
  vi.clearAllMocks()
  mocks.resolveBurnCheckpointArchive.mockResolvedValue(ARCHIVE_ROOT)
  mocks.resolveArchive.mockResolvedValue({
    root: ARCHIVE_ROOT,
    checkpointNumber: 12,
    checkpointEndBlockHeader: {},
    witnessReferenceBlockNumber: 99,
  })
  mocks.produceArchivedTxEffectsHints.mockResolvedValue({
    txEffectsHints: { txBlockHeader: { hash: async () => "blockhash" } },
  })
  mocks.extractMetadata.mockResolvedValue({
    anchorBlockHash: ANCHOR_BLOCK_HASH,
    publicKey: () => ({ x: 1n, y: 2n }),
  })
  mocks.fetchSignerApprovalWitness.mockResolvedValue({ leafSlot: 1n })
})

describe("buildWithdrawFinalizationCall", () => {
  it("submits the portal's own `withdraw` for the published burn", async () => {
    const call = await buildWithdrawFinalizationCall((await scenario()).deps, ARGS)

    expect(call.to).toBe(PORTAL)
    expect(call.withdrawalId).toBe(WITHDRAWAL_ID.toString())
    expect(decodeWithdraw(call.data)).toEqual({
      content: {
        executor: getAddress(EXECUTOR),
        userPayloadHash: PUBLISHED.userPayloadHash.toString(),
        amount: AMOUNT,
        proverTip: PROVER_TIP,
        randomness: RANDOMNESS.toBigInt(),
      },
      userPayload: hex(USER_PAYLOAD),
      relayerPayload: expect.any(String),
      epochNumber: 9n,
      numCheckpointsInEpoch: 4n,
      leafIndex: 6n,
      path: SIBLING_PATH.map((field) => field.toString()),
      checkpointNumber: 12n,
      withdrawalId: WITHDRAWAL_ID.toString(),
      teeSignature: TEE_SIGNATURE,
    })
  })

  it("rebuilds the user payload the burn committed to: its recipient and relayer tip", async () => {
    const call = await buildWithdrawFinalizationCall((await scenario()).deps, ARGS)
    const { userPayload } = decodeWithdraw(call.data) as { userPayload: Hex }
    const payload = decodePlainWithdrawalPayload(Buffer.from(userPayload.slice(2), "hex"))
    expect(payload.recipient.equals(EthAddress.fromString(RECIPIENT))).toBe(true)
    expect(payload.relayerTip).toBe(RELAYER_TIP)
  })

  it("pays the relayer tip to the caller's tip recipient, claiming the named subsidy", async () => {
    const relayerPayload = async (args: typeof ARGS & { withdrawalSubsidy?: Hex }) => {
      const call = await buildWithdrawFinalizationCall((await scenario()).deps, args)
      const { relayerPayload } = decodeWithdraw(call.data) as { relayerPayload: Hex }
      return decodePlainRelayerPayload(Buffer.from(relayerPayload.slice(2), "hex"))
    }

    const withSubsidy = await relayerPayload({ ...ARGS, withdrawalSubsidy: WITHDRAWAL_SUBSIDY })
    expect(withSubsidy.tipRecipient.equals(EthAddress.fromString(TIP_RECIPIENT))).toBe(true)
    expect(withSubsidy.withdrawalSubsidy.equals(EthAddress.fromString(WITHDRAWAL_SUBSIDY))).toBe(
      true,
    )

    const noSubsidy = await relayerPayload(ARGS)
    expect(noSubsidy.tipRecipient.equals(EthAddress.fromString(TIP_RECIPIENT))).toBe(true)
    expect(noSubsidy.withdrawalSubsidy.isZero()).toBe(true)
  })

  it("has the enclave sign the burn's own message against the archive of its own checkpoint", async () => {
    const s = await scenario()
    await buildWithdrawFinalizationCall(s.deps, ARGS)

    expect(mocks.resolveBurnCheckpointArchive.mock.calls[0]![1].toString()).toBe(BURN_TX)
    expect(mocks.resolveArchive).toHaveBeenCalledWith(expect.anything(), ARCHIVE_ROOT)
    for (const [, messageHash] of s.node.getL2ToL1MembershipWitness.mock.calls as unknown[][]) {
      expect(messageHash).toEqual(MESSAGE_HASH)
    }
    expect(s.node.getBlockHashMembershipWitness).toHaveBeenCalledWith(99, ANCHOR_BLOCK_HASH)
    expect(s.signer.signWithdrawalFinalization).toHaveBeenCalledWith(
      expect.objectContaining({
        archiveRoot: ARCHIVE_ROOT,
        messageHash: MESSAGE_HASH,
        signature: SIGNATURE,
      }),
    )
  })

  it("names the index when the burn published no such withdrawal", async () => {
    await expect(
      buildWithdrawFinalizationCall((await scenario()).deps, { ...ARGS, withdrawalIndex: 2 }),
    ).rejects.toThrow(/published 1 withdrawals; no index 2/)
  })

  it("refuses a burn through another executor before the enclave signs", async () => {
    const s = await scenario({ executor: ("0x" + "e1".repeat(20)) as Hex })
    await expect(buildWithdrawFinalizationCall(s.deps, ARGS)).rejects.toThrow(/unknown executor/)
    expect(s.signer.signWithdrawalFinalization).not.toHaveBeenCalled()
  })

  it("refuses a published recipient the burn's user payload hash does not commit to", async () => {
    const s = await scenario({ publishedRecipient: ("0x" + "45".repeat(20)) as Hex })
    await expect(buildWithdrawFinalizationCall(s.deps, ARGS)).rejects.toThrow(
      /does not match its user payload hash/,
    )
    expect(s.signer.signWithdrawalFinalization).not.toHaveBeenCalled()
  })

  it("refuses an enclave signature over a different withdrawal id", async () => {
    const s = await scenario({
      signs: async () => ({
        ...enclaveOutput(),
        withdrawalId: new Fr(1n),
      }),
    })
    await expect(buildWithdrawFinalizationCall(s.deps, ARGS)).rejects.toThrow(
      /withdrawal ID does not match/,
    )
  })

  describe("failure classification", () => {
    it("reports an already-released withdrawal before doing any work", async () => {
      const s = await scenario({ spent: true })
      const err = await buildWithdrawFinalizationCall(s.deps, ARGS).catch((e) => e)
      expect(err).toBeInstanceOf(WithdrawFinalizationError)
      expect(err.reason).toBe("already-finalized")
      expect(s.l1.readContract).toHaveBeenCalledWith(
        expect.objectContaining({
          address: PORTAL,
          functionName: "$isWithdrawalSpent",
          args: [WITHDRAWAL_ID.toString()],
        }),
      )
      expect(s.node.getL2ToL1MembershipWitness).not.toHaveBeenCalled()
      expect(s.signer.signWithdrawalFinalization).not.toHaveBeenCalled()
    })

    it("reports a burn whose epoch is not proven yet, and never calls the enclave", async () => {
      const s = await scenario({ witness: undefined })
      const err = await buildWithdrawFinalizationCall(s.deps, ARGS).catch((e) => e)
      expect(err).toBeInstanceOf(WithdrawFinalizationError)
      expect(err.reason).toBe("not-yet-finalizable")
      // The signature replays the burn checkpoint's blocks; nothing runs that speculatively.
      expect(mocks.produceArchivedTxEffectsHints).not.toHaveBeenCalled()
      expect(s.signer.signWithdrawalFinalization).not.toHaveBeenCalled()
    })

    it("reports an unreachable enclave off the vendored error type, keeping the cause", async () => {
      const cause = new EnclaveUnavailable("no healthy enclave", { status: 503 })
      const s = await scenario({
        signs: async () => {
          throw cause
        },
      })
      const err = await buildWithdrawFinalizationCall(s.deps, ARGS).catch((e) => e)
      expect(err).toBeInstanceOf(WithdrawFinalizationError)
      expect(err.reason).toBe("enclave-unavailable")
      expect(err.cause).toBe(cause)
    })

    it("propagates an enclave refusal rather than dressing it as an outage", async () => {
      const cause = new Error("enclave rejected the finalization")
      const s = await scenario({
        signs: async () => {
          throw cause
        },
      })
      await expect(buildWithdrawFinalizationCall(s.deps, ARGS)).rejects.toBe(cause)
    })
  })
})

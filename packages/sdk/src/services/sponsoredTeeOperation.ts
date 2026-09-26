/**
 * TEE-attested oxide-token operations under ClaimFPC sponsorship — the
 * composition of `buildTeeOperation` (single-sim staged execution, TEE
 * signing, capsule assembly, `publish_da`) with `buildClaimSponsorPayload`
 * (NO_FROM entrypoint batches).
 *
 * Shape parity with the account-entrypoint variant, with two differences the
 * sponsored batch imposes:
 *   - calls are `FunctionCall` structs dispatched by the FPC, matched against
 *     its policy (the shipped single `ByAny` entry matches them all; class
 *     witnesses are still supplied so a per-call ByClass policy also matches),
 *     not an account `BatchCall`;
 *   - capsules ride the ExecutionPayload tx-globally (`extraCapsules`) —
 *     they are keyed by (contract, slot), so per-call attachment was never
 *     load-bearing.
 *
 * Batch layout (MAX_SPONSORED_CALLS = 5): [account auth?, ...ops,
 * ...teeUnsignedInteractions, publish_da].
 */
import { Contract, ContractFunctionInteraction } from "@aztec/aztec.js/contracts"
import { Capsule, ExecutionPayload } from "@aztec/stdlib/tx"
import { AztecAddress } from "@aztec/stdlib/aztec-address"
import type { ContractArtifact, FunctionCall } from "@aztec/stdlib/abi"
import type { AuthWitness } from "@aztec/stdlib/auth-witness"
import { Fr } from "@aztec/aztec.js/fields"
import { createLogger } from "@aztec/foundation/log"
import {
  buildNoteSignatureCapsule,
  buildPlainExecutorUserPayloadCapsules,
  buildSeedCapsule,
  buildStrictModeCapsule,
  buildTeeMetadataCapsule,
  buildTeeNotesCapsule,
  buildTeeRequiredNullifiersCapsule,
  buildTeeWithdrawalMessageHashesCapsule,
  buildWithdrawalSignatureCapsule,
} from "@oxide/oxide-client/capsules.js"
import { assertPlainWithdrawals } from "@oxide/oxide-client/l2_operations.js"
import { declaredWithdrawals, type PlainWithdrawalContext } from "../oxide/plainWithdrawal.js"
import { TEEMetadata, type SpentDeposit, type TeeSigner } from "@oxide/oxide-lib/types.js"
import type { AztecNode } from "@aztec/aztec.js/node"
import {
  type Operation,
  type SpendMetadataResolver,
  type DepositSpendMetadataResolver,
  buildTokenOperation,
  collectAccountingEffects,
} from "../oxide/index.js"
import {
  priceDeclaredEffectDeltas,
  type FinalizedPayload,
  type PayloadFinalizer,
} from "../obsidion/stagedExecution.js"
import {
  MAX_SPONSORED_CALLS,
  buildClaimSponsorPayload,
  buildClaimSubscribePayload,
  claimFpcSponsoredFee,
  type ClaimFpcGateWitness,
  type ClaimFpcPolicy,
  type ClassWitnessInput,
} from "../feePaymentMethod/index.js"
import { computePublishDaLogEmittedLengths } from "../oxide/publishDaLogs.js"
import { dedupeByAddressString } from "./teeOperation.js"
import { assertSigningKeyApproved } from "./teeSignerApproval.js"
import type { ObsidionWallet } from "../obsidion/ObsidionWallet.js"
import type { BenchmarkFlow } from "@obsidion/core/types"
import { benchmarkRegistry } from "../obsidion/benchmark/benchmarkRegistry.js"
import { benchNow } from "../obsidion/benchmark/proveTimingExtract.js"
import { readTimingBenchFlag } from "../obsidion/proving-progress-helpers.js"

const log = createLogger("wallet-sdk:sponsored-tee-operation")

/** Extract the call struct + any capsules an interaction accumulated via `.with()`. */
async function toCallAndCapsules(
  interaction: ContractFunctionInteraction,
): Promise<{ call: FunctionCall; capsules: Capsule[] }> {
  const payload = await interaction.request()
  return { call: payload.calls[0]!, capsules: payload.capsules ?? [] }
}

export interface SponsoredTeeOperationArgs {
  fpcAddress: AztecAddress
  fpcArtifact: ContractArtifact
  /** The rail this batch rides and the policy that bounds it (`railByName`). */
  railId: number
  policy: ClaimFpcPolicy
  user: AztecAddress
  /** Owner of the intent capsule when the account authorizing the ops is not the paying `user`. */
  intentsAccount?: AztecAddress
  tokenContract: Contract
  signer: TeeSigner
  operations: Operation[]
  buildOperationCall: (op: Operation, capsules: Capsule[]) => ContractFunctionInteraction
  resolveSpendMetadata?: SpendMetadataResolver
  /** Metadata (address preimage + nullifier hiding key) for deposits the batch spends. */
  resolveDepositSpendMetadata?: DepositSpendMetadataResolver
  additionalScopes?: AztecAddress[]
  /** Class witnesses aligned with `operations` (undefined for ByAddress targets). */
  operationClassWitnesses: (ClassWitnessInput | undefined)[]
  /** Account authorization riding the batch (authorize_intents), when the ops consume intents. */
  accountCall?: { call: FunctionCall; classWitness: ClassWitnessInput }
  /**
   * Non-token calls riding the batch that the TEE does not sign — oxide `submit`'s seam of the
   * same name (e.g. the swap-on-withdraw L1-operation broadcast). They sit between the ops and
   * `publish_da` in BOTH the sim and finalized shapes; `collectTokenEffects` filters by token
   * address, so they never reach the attestation. Matched by address or `ByAny` — no class witness.
   */
  teeUnsignedInteractions?: ContractFunctionInteraction[]
  /**
   * Abort before the enclave signs unless the batch burns exactly this much. Guards a
   * caller-planned L1 leg (a swap escrow sized off a paylink's advertised amount) against a note
   * that holds less than the link claims.
   */
  expectedWithdrawalAmount?: bigint
  /** The deployment's plain withdrawal executor and portal state. Required when the batch withdraws. */
  plainWithdrawal?: PlainWithdrawalContext
  intentHashes?: Fr[]
  combinedAuthWitness?: AuthWitness
  /** First-tx subscribe on this rail: ride `subscribe` instead of `sponsor`, with the witnesses
   * the rail's gate consumes. */
  gate?: ClaimFpcGateWitness
}

export interface SponsoredTeeOperationResult {
  /** Simulation-shape sponsored payload; send with `{ from: NO_FROM, ...sendOpts }`. */
  payload: ExecutionPayload
  sendOpts: {
    additionalScopes: AztecAddress[]
    finalize: PayloadFinalizer
    /** What the policy budgets this batch at, declared as the tx's limits — see
     * `claimFpcSponsoredFee`. */
    fee: ReturnType<typeof claimFpcSponsoredFee>
  }
}

export async function buildSponsoredTeeOperation(
  ctx: {
    wallet: ObsidionWallet
    node: AztecNode
    /** Benchmark correlation id; when set (and the flag is on) the finalizer contributes the TEE leg. */
    operationId?: string
    benchmarkFlow?: BenchmarkFlow
  },
  args: SponsoredTeeOperationArgs,
): Promise<SponsoredTeeOperationResult> {
  const { node } = ctx
  // Time-perf benchmark TEE-leg span, same gate as `buildTeeOperation`: flag on
  // AND a caller-threaded operationId. `contributeTee` never throws into the flow.
  const timingBench = readTimingBenchFlag() && ctx.operationId !== undefined
  const {
    fpcAddress,
    fpcArtifact,
    user,
    tokenContract,
    signer,
    operations,
    buildOperationCall,
    resolveSpendMetadata,
    resolveDepositSpendMetadata,
    operationClassWitnesses,
  } = args
  if (operations.length === 0) {
    throw new Error("buildSponsoredTeeOperation called with no operations")
  }
  const declared = declaredWithdrawals(operations)
  if (declared.length > 0 && !args.plainWithdrawal) {
    throw new Error(
      "buildSponsoredTeeOperation: a withdrawal needs the deployment's plain withdrawal executor",
    )
  }
  assertPlainWithdrawals(declared, {
    plainWithdrawalExecutor: args.plainWithdrawal?.executor,
    fpcFundingCut: args.plainWithdrawal?.fpcFundingCut,
    portalFrozen: args.plainWithdrawal?.frozen,
  })
  const teeUnsigned = await Promise.all((args.teeUnsignedInteractions ?? []).map(toCallAndCapsules))
  const fixedCalls = (args.accountCall ? 1 : 0) + teeUnsigned.length + 1 // auth? + unsigned + publish_da
  if (operations.length + fixedCalls > MAX_SPONSORED_CALLS) {
    throw new Error(
      `sponsored TEE batch would need ${
        operations.length + fixedCalls
      } calls; the FPC dispatches at most ${MAX_SPONSORED_CALLS}`,
    )
  }
  for (const op of operations) {
    if (op.kind === "outerCall" && op.authwits?.length) {
      throw new Error(
        "sponsored TEE operations must not carry per-op authwits — intents ride the FPC intent capsule",
      )
    }
  }

  const additionalScopes = dedupeByAddressString([
    ...(args.additionalScopes ?? []),
    ...operations.flatMap((op) =>
      op.kind === "outerCall" && op.additionalScopes ? op.additionalScopes : [],
    ),
  ])

  const seedCapsule = buildSeedCapsule(tokenContract.address)

  const assembleSponsored = async (
    opCapsules: Capsule[],
    tail: { call: FunctionCall; classWitness?: undefined }[],
    extraCapsules: Capsule[],
  ): Promise<{ payload: ExecutionPayload; innerCalls: FunctionCall[] }> => {
    const innerCalls: FunctionCall[] = []
    const classWitnesses: (ClassWitnessInput | undefined)[] = []
    if (args.accountCall) {
      innerCalls.push(args.accountCall.call)
      classWitnesses.push(args.accountCall.classWitness)
    }
    const collectedOpCapsules: Capsule[] = []
    for (let i = 0; i < operations.length; i++) {
      const { call, capsules } = await toCallAndCapsules(
        buildOperationCall(operations[i]!, opCapsules),
      )
      innerCalls.push(call)
      classWitnesses.push(operationClassWitnesses[i])
      collectedOpCapsules.push(...capsules)
    }
    for (const t of teeUnsigned) {
      innerCalls.push(t.call)
      classWitnesses.push(undefined)
      collectedOpCapsules.push(...t.capsules)
    }
    for (const t of tail) {
      innerCalls.push(t.call)
      classWitnesses.push(undefined)
    }
    const common = {
      fpcAddress,
      fpcArtifact,
      railId: args.railId,
      policy: args.policy,
      user,
      intentsAccount: args.intentsAccount,
      innerCalls,
      classWitnesses,
      intentHashes: args.intentHashes,
      combinedAuthWitness: args.combinedAuthWitness,
      extraCapsules: dedupeCapsules([...collectedOpCapsules, ...extraCapsules]),
    }
    const payload = args.gate
      ? await buildClaimSubscribePayload({ ...common, gate: args.gate })
      : await buildClaimSponsorPayload(common)
    return { payload, innerCalls }
  }

  // Simulation shape: [auth?, ...ops, ...unsigned] with only the seed capsule —
  // the wallet's single internal sim is both the gas source and the effects feed
  // the TEE attests over.
  const { payload, innerCalls } = await assembleSponsored([seedCapsule], [], [seedCapsule])

  const finalize: PayloadFinalizer = async (simResult): Promise<FinalizedPayload> => {
    const anchorBlockHeader = simResult.publicInputs.constants.anchorBlockHeader
    const anchorBlockHash = await anchorBlockHeader.hash()

    const collected = collectAccountingEffects(tokenContract.address, simResult.offchainEffects)

    if (args.expectedWithdrawalAmount !== undefined) {
      const burned = collected.withdrawals.reduce((sum, w) => sum + w.amount, 0n)
      if (burned !== args.expectedWithdrawalAmount) {
        // No amounts in the message: the simulated burn is private and errors get reported.
        throw new Error(
          "buildSponsoredTeeOperation: withdrawal amount does not match the expected amount",
        )
      }
    }

    const deposits: SpentDeposit[] = []
    if (collected.deposits.length > 0 && !resolveDepositSpendMetadata) {
      throw new Error(
        `buildSponsoredTeeOperation: produced ${collected.deposits.length} spent deposit(s) but no resolveDepositSpendMetadata was supplied`,
      )
    }
    for (const spent of collected.deposits) {
      const witness = await node.getL1ToL2MessageMembershipWitness(
        anchorBlockHash,
        spent.messageHash,
      )
      if (!witness) {
        throw new Error(`No L1->L2 membership witness for deposit message ${spent.messageHash}`)
      }
      const [witnessLeafIndex, siblingPath] = witness
      if (witnessLeafIndex !== spent.inboxIndex) {
        throw new Error(
          `Deposit witness leaf index ${witnessLeafIndex} does not match deposit effect leaf index ${spent.inboxIndex}`,
        )
      }
      const metadata = await resolveDepositSpendMetadata!(spent.recipient)
      deposits.push({
        recipient: spent.recipient,
        recipientAddressPreimage: metadata.ownerAddressPreimage,
        masterNullifierHidingKey: metadata.masterNullifierHidingKey,
        amount: spent.amount,
        sharedSecretSalt: spent.sharedSecretSalt,
        messageLeafIndex: spent.inboxIndex,
        siblingPath: siblingPath.toTuple(),
      })
    }

    let spendMetadata: Awaited<ReturnType<SpendMetadataResolver>>[] = []
    if (collected.nullifiedNotes.length > 0) {
      if (!resolveSpendMetadata) {
        throw new Error(
          `buildSponsoredTeeOperation: ${collected.nullifiedNotes.length} nullified note(s) but no resolveSpendMetadata`,
        )
      }
      spendMetadata = await Promise.all(collected.nullifiedNotes.map(resolveSpendMetadata))
    }

    const tokenOperation = await buildTokenOperation(
      node,
      tokenContract.address,
      anchorBlockHeader,
      collected,
      spendMetadata,
      { deposits },
    )
    log.info("requesting TEE signature (sponsored)", {
      tokenContract: tokenContract.address.toString(),
      user: user.toString(),
      operationKinds: operations.map((op) => op.kind),
      createdNotes: tokenOperation.createdNotes.length,
      nullifiedNotes: collected.nullifiedNotes.length,
      deposits: deposits.length,
    })
    const t_enclave = timingBench ? benchNow() : 0
    const signOutput = await signer.signTokenOperation(tokenOperation)
    const enclaveMs = timingBench ? benchNow() - t_enclave : 0
    const {
      signatures,
      requiredNullifiers,
      teeNotes,
      withdrawalMessageHashes,
      withdrawalSignatures,
    } = signOutput
    const { createdNotes, withdrawals } = tokenOperation

    // The key that signed, checked before any capsule or payload exists; the recipient's PXE would
    // drop every note signed by an unapproved key. The TEE metadata capsule carries this same key.
    const signerPublicKey = await assertSigningKeyApproved({
      signer,
      node,
      tokenAddress: tokenContract.address,
      blockHash: anchorBlockHash,
    })

    const sigCapsules = await Promise.all(
      createdNotes.map((note, j) =>
        buildNoteSignatureCapsule(tokenContract.address, note.randomness, signatures[j]!),
      ),
    )
    const dummyCapsules = await Promise.all(
      collected.squashedTransientNotes.map((note) =>
        buildNoteSignatureCapsule(tokenContract.address, note.randomness, {
          sLo: Fr.zero(),
          sHi: Fr.zero(),
          rLo: Fr.zero(),
          rHi: Fr.zero(),
        }),
      ),
    )
    const withdrawalSigCapsules = await Promise.all(
      withdrawals.map((withdrawal, k) =>
        buildWithdrawalSignatureCapsule(
          tokenContract.address,
          withdrawal,
          withdrawalSignatures[k]!,
        ),
      ),
    )
    // The relayer rebuilds each withdrawal's user payload from the recipient and relayer tip these
    // capsules publish (TEMPORARY upstream, OX-1700).
    if (declared.length === 0 && withdrawals.length > 0) {
      throw new Error(
        "buildSponsoredTeeOperation: the batch withdraws without declaring its user payloads",
      )
    }
    const userPayloadCapsules = await buildPlainExecutorUserPayloadCapsules(
      tokenContract.address,
      withdrawals,
      declared.map((withdrawal) => withdrawal.userPayload),
      args.plainWithdrawal?.executor,
    )
    const realCallCapsules = [
      seedCapsule,
      buildStrictModeCapsule(tokenContract.address),
      ...sigCapsules,
      ...dummyCapsules,
      ...withdrawalSigCapsules,
      ...userPayloadCapsules,
    ]

    const teeMetadata = TEEMetadata.fromPublicKey(signerPublicKey, anchorBlockHash)
    const publishDa = await toCallAndCapsules(
      tokenContract.methods.publish_da!().with({
        capsules: [
          buildTeeNotesCapsule(tokenContract.address, teeNotes),
          buildTeeRequiredNullifiersCapsule(tokenContract.address, requiredNullifiers),
          buildTeeMetadataCapsule(tokenContract.address, teeMetadata),
          buildTeeWithdrawalMessageHashesCapsule(tokenContract.address, withdrawalMessageHashes),
        ],
      }),
    )

    const { payload: finalizedPayload } = await assembleSponsored(
      realCallCapsules,
      [{ call: publishDa.call }],
      [...realCallCapsules, ...publishDa.capsules],
    )

    const publishDaLogLengths = computePublishDaLogEmittedLengths({
      teeNotes: teeNotes.length,
      requiredNullifiers: requiredNullifiers.length,
      withdrawalMessageHashes: withdrawalMessageHashes.length,
      metadataFields: teeMetadata.toFields().length,
    })
    const gasDelta = priceDeclaredEffectDeltas({ privateLogEmittedLengths: publishDaLogLengths })

    log.info("assembled sponsored exec payload", {
      callLayout: [
        ...(args.accountCall ? ["account-auth"] : []),
        ...operations.map((op) => `op:${op.kind}`),
        ...teeUnsigned.map((t) => `unsigned:${t.call.name}`),
        "publish_da",
      ],
      sigCapsules: sigCapsules.length,
      dummyCapsules: dummyCapsules.length,
      gasDelta: { daGas: gasDelta.daGas, l2Gas: gasDelta.l2Gas },
    })

    // Benchmark TEE-leg contribution, at the END of the finalizer so a throw
    // anywhere above leaves no partial in the registry (same as `buildTeeOperation`).
    if (timingBench && ctx.operationId) {
      benchmarkRegistry.contributeTee(ctx.operationId, {
        flow: ctx.benchmarkFlow ?? "send",
        enclave: enclaveMs,
        notesUsed: collected.nullifiedNotes.length,
      })
    }

    return { payload: finalizedPayload, gasDelta }
  }

  // Priced as sent: the finalized batch appends `publish_da`.
  const fee = claimFpcSponsoredFee(args.policy, [...innerCalls, { name: "publish_da" }])

  return { payload, sendOpts: { additionalScopes, finalize, fee } }
}

/** Capsules are keyed by (contract, slot); a duplicate key would shadow — keep the LAST writer. */
function dedupeCapsules(capsules: Capsule[]): Capsule[] {
  const byKey = new Map<string, Capsule>()
  for (const c of capsules) {
    byKey.set(`${c.contractAddress.toString()}:${c.storageSlot.toString()}`, c)
  }
  return [...byKey.values()]
}

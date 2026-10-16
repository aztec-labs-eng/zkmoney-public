import { NO_FROM } from "@aztec/aztec.js/account"
import { EthAddress } from "@aztec/aztec.js/addresses"
import type { ContractFunctionInteraction } from "@aztec/aztec.js/contracts"
import { Fr } from "@aztec/aztec.js/fields"
import type { AztecNode } from "@aztec/aztec.js/node"
import { poseidon2HashWithSeparator } from "@aztec/foundation/crypto/poseidon"
import { siloNullifier } from "@aztec/stdlib/hash"
import { MerkleTreeId } from "@aztec/stdlib/trees"
import type { FunctionCall } from "@aztec/stdlib/abi"
import type { ExecutionPayload } from "@aztec/stdlib/tx"
import {
  buildSipaDeployAndSweepOperation,
  decodeUserRecordMetadata,
  depositPayoutTokenFor,
  SipaIntent,
} from "@oxide/l1-contracts"
import {
  broadcastL1Operation,
  type L1OperationBroadcaster,
} from "@oxide/oxide-client/broadcaster_calls.js"
import type { SipaNotifier } from "@oxide/oxide-client/sipa_event_calls.js"
import {
  encodeL1OperationCalldata,
  L1OperationCondition,
  type BroadcastL1Operation,
} from "@oxide/oxide-lib/l1_operation_calldata.js"
import type { Address, PublicClient } from "viem"
import {
  buildClaimSponsorPayload,
  buildClaimSubscribePayload,
} from "../feePaymentMethod/claimSponsoredCall.js"
import { claimFpcSponsoredFee } from "../feePaymentMethod/claimFpcBatchGas.js"
import { assertMetadataUpdateFresh, type PreparedMetadataUpdate } from "./metadataMigration.js"
import { assertSubsidySweepsSipa, buildSipaBroadcast } from "./sipaIntents.js"
import { computeStealthRecipientHash } from "./sipaStealth.js"
import type { ObsidionWallet } from "../obsidion/ObsidionWallet.js"
import { hasClaimFpcSubscription } from "./claimSponsor.js"

type SubscribeOptions = Parameters<typeof buildClaimSubscribePayload>[0]

export type MigrationSponsorship =
  | { kind: "bootstrap"; gate: SubscribeOptions["gate"] }
  | { kind: "registered" }

/** Matches this wallet's ClaimFPC gate.nr and subscribe. Identity is L1 owner, independent of L2 address. */
export async function claimFpcIdentitySubscribed(
  node: Pick<AztecNode, "findLeavesIndexes">,
  fpc: SubscribeOptions["fpcAddress"],
  owner: Address,
  railId: number,
): Promise<boolean> {
  const inner = await poseidon2HashWithSeparator([new Fr(BigInt(owner)), new Fr(railId)], 1236)
  const [leaf] = await node.findLeavesIndexes("latest", MerkleTreeId.NULLIFIER_TREE, [
    await siloNullifier(fpc, inner),
  ])
  return leaf !== undefined
}

export interface MigrationBootstrapOptions {
  client: PublicClient
  wallet: ObsidionWallet
  metadata: PreparedMetadataUpdate
  /** The destination token; it emits the SIPA event to the recipient. */
  token: SipaNotifier
  /** The destination L2 broadcaster the relayer reads L1 operations from. */
  broadcaster: L1OperationBroadcaster
  messageSecret: Fr
  refund?: BroadcastL1Operation
  setupCalls?: FunctionCall[]
  sponsorship: MigrationSponsorship
  fpc: Omit<SubscribeOptions, "innerCalls" | "gate">
}

export interface PreparedMigrationBootstrap {
  payload: ExecutionPayload
  innerCalls: FunctionCall[]
  /** The deploy-and-sweep the broadcast hands the relayer; it waits for the SIPA's balance. */
  metadataOperation: BroadcastL1Operation
  sendOptions: {
    from: typeof NO_FROM
    sendMessagesAs: SubscribeOptions["user"]
    additionalScopes: SubscribeOptions["user"][]
    fee: ReturnType<typeof claimFpcSponsoredFee>
  }
  metrics: {
    topLevelCalls: number
    metadataBytes: number
    metadataMethod: string
    refundBytes: number
    refundMethod?: string
  }
}

/** Prepare the entire sponsored transaction. This function never sends or consumes the allowance. */
export async function prepareMigrationBootstrap(
  args: MigrationBootstrapOptions,
): Promise<PreparedMigrationBootstrap> {
  if (args.sponsorship.kind === "bootstrap" && args.sponsorship.gate.kind !== "nameClaim") {
    throw new Error("Bootstrap migration requires the NameClaim registration-broadcast rail")
  }
  const { metadata, fpc } = args
  if (args.sponsorship.kind === "bootstrap") {
    if (
      await claimFpcIdentitySubscribed(
        args.wallet.node,
        fpc.fpcAddress,
        metadata.intent.owner,
        fpc.railId,
      )
    ) {
      throw new Error(
        "The registration-broadcast allowance is already spent for this identity and FPC",
      )
    }
  } else if (
    !(await hasClaimFpcSubscription(
      args.wallet,
      fpc.fpcAddress,
      fpc.fpcArtifact,
      fpc.user,
      fpc.railId,
    ))
  ) {
    throw new Error("The destination account has no registered sponsorship subscription")
  }
  const recipient = await computeStealthRecipientHash(args.messageSecret, fpc.user)
  const record = decodeUserRecordMetadata(metadata.intent.metadata)
  if (
    recipient.toString().toLowerCase() !== metadata.intent.recipientCommitment.toLowerCase() ||
    record.l2Address.toLowerCase() !== fpc.user.toString().toLowerCase()
  ) {
    throw new Error("Metadata, deposit secret, and sponsored account must name the same recipient")
  }
  if (
    metadata.intent.namePortalRecipient.toLowerCase() !== fpc.fpcAddress.toString().toLowerCase()
  ) {
    throw new Error("Metadata attestation names a different destination FPC")
  }
  const { destination } = metadata
  await assertSubsidySweepsSipa(args.client, {
    depositSubsidy: destination.depositSubsidy,
    portal: destination.portal,
    sipaFactory: destination.factory,
    intent: SipaIntent.UpdateMetadata,
    deployArgs: metadata.deployArgs,
    intentData: metadata.intentData,
    sipa: metadata.sipa,
  })
  const token = EthAddress.fromString(destination.token)
  const operation = buildSipaDeployAndSweepOperation({
    sipa: metadata.sipa,
    sipaFactory: destination.factory,
    intent: SipaIntent.UpdateMetadata,
    deployArgs: metadata.deployArgs,
    sweepArgs: {
      token: destination.token,
      relayer: destination.operationExecutor,
      intentData: metadata.intentData,
      proofs: metadata.proofs,
    },
    depositSubsidy: destination.depositSubsidy,
    payoutToken: depositPayoutTokenFor(destination.chainId, token).toString() as Address,
    condition: L1OperationCondition.balance(token, EthAddress.fromString(metadata.sipa)),
  })
  const interactions: ContractFunctionInteraction[] = [
    ...(args.refund ? [broadcastL1Operation(args.broadcaster, args.refund)] : []),
    ...buildSipaBroadcast(
      args.token,
      args.broadcaster,
      {
        recipient: fpc.user,
        sharedSecretSalt: args.messageSecret,
        resweepable: false,
        intentHash: metadata.deployArgs.intentHash,
      },
      [operation],
    ),
  ]
  const innerCalls = [...(args.setupCalls ?? [])]
  for (const interaction of interactions) innerCalls.push(...(await interaction.request()).calls)
  const metadataTier = encodeL1OperationCalldata(operation.calldata)
  const refundTier = args.refund && encodeL1OperationCalldata(args.refund.calldata)
  const payload =
    args.sponsorship.kind === "bootstrap"
      ? await buildClaimSubscribePayload({ ...fpc, innerCalls, gate: args.sponsorship.gate })
      : await buildClaimSponsorPayload({ ...fpc, innerCalls })
  await assertMetadataUpdateFresh(args.client, metadata)
  return {
    payload,
    innerCalls,
    metadataOperation: operation,
    sendOptions: {
      from: NO_FROM,
      sendMessagesAs: fpc.user,
      additionalScopes: [fpc.user],
      fee: claimFpcSponsoredFee(fpc.policy, innerCalls),
    },
    metrics: {
      topLevelCalls: innerCalls.length,
      metadataBytes: metadataTier.bytesLen,
      metadataMethod: metadataTier.tier.method,
      refundBytes: refundTier?.bytesLen ?? 0,
      refundMethod: refundTier?.tier.method,
    },
  }
}

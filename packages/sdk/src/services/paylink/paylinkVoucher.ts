import { planPayout, type WithdrawalOptions } from "../plainWithdrawal.js"
/**
 * A paylink's voucher: the escrow's own single-use subscription on the ClaimFPC voucher rail, gifted
 * by the creator in the create batch and spent by whoever holds the link. These legs take a wallet,
 * the contract service and a TEE signer, never an account: the escrow's keys, derived from the link's
 * secret, are the only identity a sponsored exit needs, so a recipient with no account, passkey or
 * registration can burn the escrow to an Ethereum address.
 */
import { NO_FROM } from "@aztec/aztec.js/account"
import type { EthAddress } from "@aztec/aztec.js/addresses"
import { Contract, type ContractFunctionInteraction } from "@aztec/aztec.js/contracts"
import { Fr } from "@aztec/aztec.js/fields"
import { AztecAddress } from "@aztec/stdlib/aztec-address"
import type { ContractArtifact } from "@aztec/stdlib/abi"
import {
  getContractInstanceFromInstantiationParams,
  type ContractInstanceWithAddress,
} from "@aztec/stdlib/contract"
import type { TeeSigner } from "@oxide/oxide-lib/types.js"
import {
  ContractService,
  DEFAULT_CONTRACTS,
  ensureContractRegisteredInPXE,
  type ContractName,
} from "@obsidion/contracts"
import type { ObsidionWallet } from "../../obsidion/ObsidionWallet.js"
import {
  contractClassWitness,
  registerSponsorFpc,
  type ClaimSponsorContext,
  linkChainInfo,
} from "../claimSponsor.js"
import type { PaylinkParams } from "../PaylinkService.js"
import { buildSponsoredTeeOperation } from "../sponsoredTeeOperation.js"
import { buildOperationCall } from "./paylinkClaimSubmit.js"
import { assertLinkChain, assertLinkClass } from "./paylinkInlineCodec.js"
import { paylinkL1ClaimArgs, type PaylinkL1Proof } from "./paylinkL1Claim.js"
import {
  derivePaylinkKeys,
  registerEscrowTagSecret,
  registerPaylinkContractWithKeys,
  type PaylinkKeyMaterial,
} from "./paylinkKeys.js"
import { buildPaylinkNoteView, type PaylinkNoteView } from "./paylinkNoteData.js"
import { findEscrowDepositTx } from "./paylinkRecovery.js"
import { makePaylinkSpendMetadataResolver } from "./paylinkSpendMetadata.js"

export interface PaylinkVoucherDeps {
  wallet: ObsidionWallet
  contractService: ContractService
  /** The voucher rail (`railByName`), where the escrow's note lives. */
  sponsor: ClaimSponsorContext
}

/** Rebuild the escrow from the link and give this PXE its keys, its tag and its sender. Idempotent. */
export async function registerEscrow(
  deps: Pick<PaylinkVoucherDeps, "wallet" | "contractService">,
  params: PaylinkParams,
): Promise<{
  instance: ContractInstanceWithAddress
  keys: PaylinkKeyMaterial
  artifact: ContractArtifact
}> {
  const paylinkType = params.paylinkType as ContractName
  const artifact = await deps.contractService.getArtifactForContract(paylinkType)
  const keys = await derivePaylinkKeys({
    secretKey: params.secret,
    fallbackKeyHash: params.fallbackKeyHash,
  })
  const instance = await getContractInstanceFromInstantiationParams(artifact, {
    salt: new Fr(0n),
    publicKeys: keys.publicKeys,
  })
  assertLinkClass(params, instance)
  assertLinkChain(params, await linkChainInfo(deps.wallet))
  await registerPaylinkContractWithKeys({
    wallet: deps.wallet,
    instance,
    artifact,
    keyMaterial: keys,
  })
  // The escrow tags its own notes, the voucher included, so it is its own sender here.
  await deps.wallet.registerSender(instance.address)
  // The escrow's token note is tagged by the creator; a sponsored create carries the point to it.
  if (params.escrowTagSecret) {
    await registerEscrowTagSecret({
      wallet: deps.wallet,
      escrow: instance.address,
      secret: params.escrowTagSecret,
    })
  }
  return { instance, keys, artifact }
}

/** The escrow note behind a link, read with no account: what a bearer cash-out can burn. */
export async function readPaylinkEscrowNote(
  deps: Pick<PaylinkVoucherDeps, "wallet" | "contractService">,
  params: PaylinkParams,
): Promise<PaylinkNoteView> {
  const { instance, artifact } = await registerEscrow(deps as PaylinkVoucherDeps, params)
  const escrow = Contract.at(instance.address, artifact, deps.wallet)
  const sim = await escrow.methods.sync_note!().simulate({
    from: NO_FROM,
    additionalScopes: [instance.address],
  })
  return buildPaylinkNoteView(sim.result)
}

/** Sponsored txs the link's escrow still holds on the voucher rail: how many exits it can pay for. */
export async function paylinkVoucherUses(
  deps: PaylinkVoucherDeps,
  params: PaylinkParams,
): Promise<number> {
  const { instance } = await registerEscrow(deps, params)
  const fpcArtifact = await registerSponsorFpc(deps.wallet, deps.sponsor)
  const fpc = Contract.at(deps.sponsor.fpcAddress, fpcArtifact, deps.wallet)
  const result = await fpc.methods.get_subscription_uses!(
    instance.address,
    deps.sponsor.railId,
  ).simulate({ from: instance.address, additionalScopes: [instance.address] } as never)
  return Number((result as { result: unknown }).result)
}

export interface PaylinkExitArgs extends PaylinkVoucherDeps {
  params: PaylinkParams
  tokenAddress: AztecAddress
  signer: TeeSigner
  l1Recipient: EthAddress
  /** Defaults to zero; the portal pays it out of `amount` on L1. */
  proverTip?: bigint
  withdrawal: WithdrawalOptions
  operationId?: string
  zkProof?: PaylinkL1Proof
}

/**
 * Burn a vouchered link's escrow to `l1Recipient` through the ClaimFPC voucher rail. The escrow is
 * the batch's `user` and its own note pays, so no account call rides the batch and no account is
 * needed to build it. Email exits carry a zkJWT proof bound to the payout.
 */
export async function exitPaylinkWithVoucher(
  args: PaylinkExitArgs,
): Promise<{ txHash: string; blockNumber: number; amount: bigint; l1Recipient: string }> {
  const { params } = args
  const proverTip = args.proverTip ?? 0n
  const { instance, keys, artifact } = await registerEscrow(args, params)
  const { amount, tokenAddress } = await readPaylinkEscrowNote(args, params)
  if (!tokenAddress.equals(args.tokenAddress)) {
    throw new Error("The paylink note token differs from its withdrawal source")
  }
  const payout = await planPayout(
    args.wallet,
    args.contractService,
    args.tokenAddress,
    { from: instance.address, recipient: args.l1Recipient, amount, proverTip },
    args.withdrawal,
  )
  const claimArgs = await paylinkL1ClaimArgs(
    params.paylinkType,
    { executor: payout.plainWithdrawal.executor, userPayload: payout.userPayload },
    proverTip,
    args.zkProof,
  )
  const fpcArtifact = await registerSponsorFpc(args.wallet, args.sponsor)
  const tokenArtifact = await args.contractService.getArtifactForContract(
    DEFAULT_CONTRACTS.oxideToken,
    args.tokenAddress,
  )
  await ensureContractRegisteredInPXE(args.wallet.pxe, args.wallet.node, args.tokenAddress, () =>
    Promise.resolve(tokenArtifact),
  )
  const token = Contract.at(args.tokenAddress, tokenArtifact, args.wallet)
  const escrow = Contract.at(instance.address, artifact, args.wallet)

  const op = await buildSponsoredTeeOperation(
    {
      wallet: args.wallet,
      node: args.wallet.node as never,
      operationId: args.operationId,
      benchmarkFlow: "paylink-claim",
    },
    {
      fpcAddress: args.sponsor.fpcAddress,
      fpcArtifact,
      railId: args.sponsor.railId,
      policy: args.sponsor.policy,
      user: instance.address,
      tokenContract: token,
      signer: args.signer,
      operations: [
        {
          kind: "outerCall",
          interaction: escrow.methods.claim_to_l1!(...claimArgs),
          additionalScopes: [instance.address],
          withdrawals: [
            {
              executor: payout.plainWithdrawal.executor,
              userPayload: payout.userPayload,
              amount,
              proverTip,
            },
          ],
        },
      ],
      buildOperationCall,
      resolveSpendMetadata: makePaylinkSpendMetadataResolver(
        instance,
        (
          await findEscrowDepositTx(args.wallet.node, instance)
        )?.txHash,
        keys,
      ),
      operationClassWitnesses: [await contractClassWitness(instance)],
      teeUnsignedInteractions: payout.broadcasts,
      plainWithdrawal: payout.plainWithdrawal,
      // The escrow note sizes any swap escrow the caller planned; a burn of anything else would
      // strand it in an escrow that never executes.
      expectedWithdrawalAmount: amount,
    },
  )

  // The escrow is the only identity in the tx: it is the batch's user, the tag sender and the scope.
  const sent = await args.wallet.sendTx(op.payload, {
    from: NO_FROM,
    sendMessagesAs: instance.address,
    additionalScopes: [instance.address, ...op.sendOpts.additionalScopes],
    finalize: op.sendOpts.finalize,
    fee: op.sendOpts.fee,
    operationId: args.operationId,
    kind: "paylink-claim",
  })
  const receipt = (sent as { receipt?: { txHash?: { toString(): string }; blockNumber?: number } })
    .receipt
  if (!receipt?.txHash) throw new Error("sponsored paylink exit returned no tx hash")
  return {
    txHash: receipt.txHash.toString(),
    blockNumber: receipt.blockNumber ?? 0,
    amount,
    l1Recipient: args.l1Recipient.toString(),
  }
}

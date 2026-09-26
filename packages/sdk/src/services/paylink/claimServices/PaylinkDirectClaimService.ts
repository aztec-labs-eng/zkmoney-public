import { emptyTransferMeta } from "@obsidion/core/constants"
import { ObsidionWallet } from "../../../obsidion/ObsidionWallet.js"
import { MethodOptions, ServiceBase } from "../../ServiceBase.js"
import type { ClaimService, ClaimSubmitContext, ClaimTransactionResult } from "../types.js"
import { preparePaylinkClaimSubmit } from "../paylinkClaimSubmit.js"
import { Account } from "@aztec/aztec.js/account"
import { Fr } from "@aztec/aztec.js/fields"
import { AztecAddress } from "@aztec/stdlib/aztec-address"
import { ContractBase } from "@aztec/aztec.js/contracts"
import assert from "assert"

/**
 * Claim service for direct paylinks — no proof needed. Calls
 * `contractInstance.methods.claim!(recipient)` (the payout target; explicit so
 * the claim works from any callstack, including FPC-sponsored) and routes
 * through the shared `preparePaylinkClaimSubmit` helper so the inner
 * `transfer(paylink, recipient, amount, meta, 0)` carries the TEE
 * capsules in the same batched tx.
 */
export class PaylinkDirectClaimService extends ServiceBase implements ClaimService {
  private sender: Account
  public contractAddress?: AztecAddress

  constructor(wallet: ObsidionWallet, sender: Account) {
    super(wallet)
    this.sender = sender
  }

  public async claimPayment(
    contractInstance: ContractBase,
    _proof: unknown,
    recipient: Account,
    submitContext: ClaimSubmitContext,
    options?: MethodOptions,
  ): Promise<ClaimTransactionResult> {
    this.emitInit()
    assert(contractInstance, "Contract instance required")

    // This service claims through the recipient's OWN account (msg_sender ==
    // recipient), so authorize_once takes the self path, which requires
    // authwit_nonce == 0. A sponsored/foreign claim (FPC callstack) instead
    // supplies a fresh nonce and the recipient's authwit over the nonce'd call.
    const interaction = contractInstance.methods.claim!(
      recipient.getAddress(),
      new Fr(0),
      submitContext.transferMeta ?? emptyTransferMeta(),
    )

    const { initFn, buildResult, sendOptions } = await preparePaylinkClaimSubmit({
      wallet: this.wallet,
      node: this.wallet.node,
      interaction,
      batchSender: recipient.getAddress(),
      submitContext,
      options,
    })

    return this.sendAndWait(initFn, buildResult, {
      sendOptions,
      profile: options?.profile,
      operationId: options?.operationId,
      kind: options?.kind,
    })
  }
}

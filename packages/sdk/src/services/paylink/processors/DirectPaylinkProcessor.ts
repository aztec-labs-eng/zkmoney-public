import { FieldLike } from "@aztec/aztec.js/abi"
import { ContractName, DEFAULT_CONTRACTS } from "@obsidion/contracts"
import { CommitmentInput, ClaimInput } from "../types.js"
import { BasePaylinkProcessor, DepositArg, PaylinkConstructorArgs } from "./BasePaylinkProcessor.js"

/**
 * Processor for direct paylinks — no identity verification.
 * Anyone who holds the link can claim.
 */
export class DirectPaylinkProcessor extends BasePaylinkProcessor {
  /**
   * Direct paylinks have no commitment — always returns 0n.
   * The contract internally uses hash=0 for the note.
   */
  async computeCommitmentHash(_input?: CommitmentInput): Promise<FieldLike> {
    return 0n
  }

  getContractName(): ContractName {
    return DEFAULT_CONTRACTS.paylinkDirect
  }

  /**
   * Matches PaylinkDirect.deposit(amount, from_claimable, until_claimable, refundable_until,
   * token_address, sender, meta). No hash parameter — the contract sets hash=0 internally.
   */
  getConstructorArgs(args: PaylinkConstructorArgs): DepositArg[] {
    if (!args.sender) throw new Error("direct paylink deposit requires the funding sender")
    return [
      args.amount,
      args.window.fromClaimable,
      args.window.untilClaimable,
      args.window.refundableUntil,
      args.token,
      args.sender,
      args.meta,
    ]
  }

  /**
   * No claim inputs needed — claim() takes zero arguments.
   */
  async prepareClaimInputs(_proof: ClaimInput): Promise<null> {
    return null
  }
}

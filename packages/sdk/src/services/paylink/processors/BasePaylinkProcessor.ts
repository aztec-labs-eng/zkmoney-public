import { AztecAddress } from "@aztec/stdlib/aztec-address"
import { FieldLike } from "@aztec/aztec.js/abi"
import { ContractName } from "@obsidion/contracts"
import { CommitmentInput, ClaimInput, PaylinkWindow } from "../types.js"

/**
 * Constructor arguments that might be needed by paylink contracts
 */
export interface PaylinkConstructorArgs {
  amount: bigint
  hash: FieldLike
  token: AztecAddress
  window: PaylinkWindow
  // OidcKeyRegistry address + zkJWT vkey hash this paylink binds to (email flavor).
  registry_address?: AztecAddress
  vkey_hash?: FieldLike
  // Funding account (direct flavor): refund rights bind to it; the token authwit-gates the pull
  // when the creation is sponsored (msg_sender != sender). Injected by PaylinkService.
  sender?: AztecAddress
  // The funding transfer's `Transfer.meta`, already encoded. Built once by PaylinkService so the
  // sender's pull authwit hashes exactly the fields `deposit` passes to the token.
  meta: FieldLike[]
}

/** One `deposit` calldata arg: a field, or the transfer meta's field array. */
export type DepositArg = FieldLike | FieldLike[]

/**
 * Abstract base class for paylink type processors
 * Each paylink type (email, direct) extends this to provide type-specific logic
 */
export abstract class BasePaylinkProcessor {
  /**
   * Compute the commitment hash from input data
   * Each processor implements its own hashing logic based on the commitment type
   * @param input - The input data specific to this paylink type (the email address)
   * @returns Promise resolving to the commitment hash as Fr
   */
  abstract computeCommitmentHash(input?: CommitmentInput): Promise<FieldLike>

  /**
   * Get the contract name for this paylink type
   * @returns The contract name to use for this paylink
   * This is the identifier for the paylink type
   */
  abstract getContractName(): ContractName

  /**
   * Get the constructor arguments in the correct order for this contract type
   * Different contracts may have different constructor signatures
   * @param args - The paylink constructor parameters
   * @returns Array of arguments in the order expected by the contract constructor
   */
  abstract getConstructorArgs(args: PaylinkConstructorArgs): DepositArg[]

  /**
   * Prepare claim inputs for the contract claim method
   * Transforms proof data into the format expected by the contract
   * @param proof - The proof data specific to this paylink type
   * @returns Promise resolving to the prepared claim inputs
   */
  abstract prepareClaimInputs(proof: ClaimInput): Promise<unknown>
}

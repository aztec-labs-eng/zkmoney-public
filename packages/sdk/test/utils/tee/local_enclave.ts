// ─────────────────────────────────────────────────────────────────────────────
// VENDORED from oxide@804921b9 `yarn-project/end-to-end/src/test_utils/tee/local_enclave.ts`.
//
// `@oxide/end-to-end` is test-internal and not in this workspace, so obsidion cannot import
// `LocalEnclave` from it. Re-sync this file on the next oxide bump.
// ─────────────────────────────────────────────────────────────────────────────
import type { EthAddress } from "@aztec-labs/foundation/eth-address"

import type {
  RegisteredSignTokenOperationOutput,
  RegisteredTeeSigner,
} from "@oxide/oxide-client/types.js"
import type {
  EnclaveIdentity,
  FrozenDepositsRefundFinalizationInput,
  FrozenDepositsRefundFinalizationOutput,
  FrozenNotesRefundFinalizationInput,
  FrozenNotesRefundFinalizationOutput,
  P256PublicKey,
  SecpPublicKey,
  TokenOperation,
  UnprocessedDepositRefundFinalizationInput,
  UnprocessedDepositRefundFinalizationOutput,
  WithdrawalFinalizationInput,
  WithdrawalFinalizationOutput,
} from "@oxide/oxide-lib/types.js"
import type { LocalTeeSigner } from "@oxide/tee-enclave/signer.js"

/** An in-process enclave registered on a `TeeRegistry`: the test counterpart of `PinnedEnclave`. */
export class LocalEnclave implements RegisteredTeeSigner, EnclaveIdentity {
  constructor(readonly signer: LocalTeeSigner, readonly registrationLeafIndex: bigint) {}

  get publicKey(): SecpPublicKey {
    return this.signer.publicKey
  }

  get ethAddress(): EthAddress {
    return this.signer.ethAddress
  }

  get encryptionPublicKey(): P256PublicKey {
    return this.signer.encryptionPublicKey
  }

  get teeRegistry(): EthAddress {
    return this.signer.teeRegistry
  }

  async signTokenOperation(operation: TokenOperation): Promise<RegisteredSignTokenOperationOutput> {
    const output = await this.signer.signTokenOperation(operation)
    return {
      ...output,
      publicKey: this.publicKey,
      registrationLeafIndex: this.registrationLeafIndex,
    }
  }

  signWithdrawalFinalization(
    input: WithdrawalFinalizationInput,
  ): Promise<WithdrawalFinalizationOutput> {
    return this.signer.signWithdrawalFinalization(input)
  }

  signFrozenNotesRefundFinalization(
    input: FrozenNotesRefundFinalizationInput,
  ): Promise<FrozenNotesRefundFinalizationOutput> {
    return this.signer.signFrozenNotesRefundFinalization(input)
  }

  signFrozenDepositsRefundFinalization(
    input: FrozenDepositsRefundFinalizationInput,
  ): Promise<FrozenDepositsRefundFinalizationOutput> {
    return this.signer.signFrozenDepositsRefundFinalization(input)
  }

  signUnprocessedDepositRefundFinalization(
    input: UnprocessedDepositRefundFinalizationInput,
  ): Promise<UnprocessedDepositRefundFinalizationOutput> {
    return this.signer.signUnprocessedDepositRefundFinalization(input)
  }
}

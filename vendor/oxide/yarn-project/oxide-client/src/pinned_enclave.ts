import { EthAddress } from '@aztec/stdlib/block';

import type { AttestationData } from '@oxide/oxide-lib/attestation/attestation_data.js';
import { ethAddressFromSecpPublicKey } from '@oxide/oxide-lib/attestation/user_data.js';
import {
  type RpcMethod,
  type RpcParams,
  type RpcResult,
  decodeResponseEnvelope,
  encodeEncryptedRequest,
  encodeRequest,
  parseInnerResult,
} from '@oxide/oxide-lib/codec.js';
import { P256PublicKey, type SealedRequest, sealRequest } from '@oxide/oxide-lib/encryption.js';
import type {
  FrozenDepositRefundFinalizationInput,
  FrozenDepositRefundFinalizationOutput,
  FrozenNotesRefundFinalizationInput,
  FrozenNotesRefundFinalizationOutput,
  SecpPublicKey,
  SignTokenOperationOutput,
  TeeSigner,
  TokenOperation,
  UnprocessedDepositRefundFinalizationInput,
  UnprocessedDepositRefundFinalizationOutput,
  WithdrawalFinalizationInput,
  WithdrawalFinalizationOutput,
} from '@oxide/oxide-lib/types.js';

import { type Timeouts, postFrame } from './enclave_transport.js';
import { EnclaveRejected, EnclaveUnavailable } from './errors.js';

/**
 * A request sealed to one enclave. `send` may be called repeatedly: the enclave is deterministic and
 * keeps nothing per request, so a retry after a transport failure can resend the identical bytes
 * rather than re-sealing — which for a max-size operation is the difference between a resend and
 * re-encrypting a hundred-plus megabytes.
 */
export interface SealedCall<M extends RpcMethod> {
  send(): Promise<RpcResult<M>>;
}

/**
 * An immutable handle to one enclave, addressed by the identity in its attestation.
 *
 * Every key and address derives from the attestation this was built with, so the identity can never
 * change under a caller — hold this when you need one that stays put. A pinned enclave that dies stays
 * dead and its calls fail; recovering by moving to another enclave is `FleetSigner`'s job.
 *
 * Nothing here verifies anything. Build these through `FleetSigner.connect`, which checks the
 * attestation against the portal's registration binding first; the constructor is public only for
 * flows that have already done that check themselves.
 */
export class PinnedEnclave implements TeeSigner {
  constructor(
    readonly url: string,
    readonly attestation: AttestationData,
    private readonly timeouts: Timeouts,
  ) {}

  get publicKey(): SecpPublicKey {
    return { x: this.attestation.userData.publicKeyX, y: this.attestation.userData.publicKeyY };
  }

  get ethAddress(): EthAddress {
    return ethAddressFromSecpPublicKey(this.publicKey);
  }

  get encryptionPublicKey(): P256PublicKey {
    return P256PublicKey.fromCoordinates({
      x: this.attestation.userData.encPubKeyX,
      y: this.attestation.userData.encPubKeyY,
    });
  }

  signTokenOperation(operation: TokenOperation): Promise<SignTokenOperationOutput> {
    return this.call('signTokenOperation', operation);
  }

  signWithdrawalFinalization(input: WithdrawalFinalizationInput): Promise<WithdrawalFinalizationOutput> {
    return this.call('signWithdrawalFinalization', input);
  }

  signFrozenNotesRefundFinalization(
    input: FrozenNotesRefundFinalizationInput,
  ): Promise<FrozenNotesRefundFinalizationOutput> {
    return this.call('signFrozenNotesRefundFinalization', input);
  }

  signFrozenDepositRefundFinalization(
    input: FrozenDepositRefundFinalizationInput,
  ): Promise<FrozenDepositRefundFinalizationOutput> {
    return this.call('signFrozenDepositRefundFinalization', input);
  }

  signUnprocessedDepositRefundFinalization(
    input: UnprocessedDepositRefundFinalizationInput,
  ): Promise<UnprocessedDepositRefundFinalizationOutput> {
    return this.call('signUnprocessedDepositRefundFinalization', input);
  }

  /**
   * Seal a request to this enclave without sending it, so a caller that owns a retry policy can send
   * the same bytes more than once. Sealing binds the request to this enclave's encryption key: moving
   * to a different enclave requires preparing again.
   */
  async prepare<M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<SealedCall<M>> {
    const sealed = await sealRequest(this.encryptionPublicKey, Buffer.from(encodeRequest(method, params), 'utf8'));
    const body = encodeEncryptedRequest(sealed.wirePayload);
    const address = this.ethAddress.toString();
    return {
      send: async () => {
        const replyJson = await postFrame(this.url, body, this.timeouts.operationMs, address);
        return await this.unseal(method, sealed, replyJson);
      },
    };
  }

  private async call<M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResult<M>> {
    return await (await this.prepare(method, params)).send();
  }

  /** Unwrap the host-visible outer envelope, then the HPKE-sealed inner one. Only an authenticated
   *  inner refusal is the enclave's verdict; anything outer is host-controlled transport. */
  private async unseal<M extends RpcMethod>(
    method: M,
    sealed: SealedRequest,
    replyJson: string,
  ): Promise<RpcResult<M>> {
    const outer = await decodeResponseEnvelope(replyJson);
    // Outer response bytes are host-controlled. Only an HPKE-authenticated inner verdict is permanent.
    if (outer.kind !== 'encrypted') {
      throw new EnclaveUnavailable(
        outer.kind === 'error'
          ? `enclave proxy returned unauthenticated error for ${method}: ${outer.error}`
          : `enclave proxy returned unauthenticated plaintext response for ${method}`,
      );
    }
    const inner = await decodeResponseEnvelope((await sealed.openResponse(outer.ciphertext)).toString('utf8'));
    if (inner.kind === 'error') {
      throw new EnclaveRejected(`enclave refused ${method}: ${inner.error}`);
    }
    if (inner.kind !== 'plaintext') {
      throw new EnclaveRejected(`enclave nested a sealed response inside ${method}'s sealed response`);
    }
    return await parseInnerResult(method, inner.result);
  }
}

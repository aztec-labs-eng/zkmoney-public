import { EthAddress } from '@aztec/stdlib/block';

import { OxidePortalContract } from '@oxide/l1-contracts/oxide_portal.js';
import type { AttestationData } from '@oxide/oxide-lib/attestation/attestation_data.js';
import { ethAddressFromSecpPublicKey } from '@oxide/oxide-lib/attestation/user_data.js';
import type { RpcMethod, RpcParams, RpcResult } from '@oxide/oxide-lib/codec.js';
import type { P256PublicKey } from '@oxide/oxide-lib/encryption.js';
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

import { DEFAULT_TIMEOUTS, type Timeouts, fetchUnverifiedAttestation } from './enclave_transport.js';
import { EnclaveUnavailable } from './errors.js';
import { PinnedEnclave, type SealedCall } from './pinned_enclave.js';

export interface FleetSignerOptions {
  timeouts?: Partial<Timeouts>;
  /** Attempts for one operation. An attempt is "obtain a usable pin, then send", so a re-pin that
   *  fails spends one — a fleet with nothing to pin cannot be spun on. */
  maxAttempts?: number;
}

const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * A `TeeSigner` over a fleet of enclaves reached at one URL.
 *
 * Every registered enclave is an equal peer, so this pins one — verified against the portal's
 * registration binding — and seals every request to it. When the fleet reports that pin is gone, it
 * pins another and retries. A fleet reporting no routable enclave at all fails on the spot instead:
 * capacity comes back only when a replacement host boots and registers, minutes later, so retrying
 * here would burn the budget to reach the same conclusion and hide the condition from the caller's
 * retry loop, which is the only thing on the right timescale.
 *
 * The keys and address therefore track whichever enclave is currently pinned. Callers that need an
 * identity which cannot change should hold {@link FleetSigner.enclave} instead.
 */
export class FleetSigner implements TeeSigner {
  private pinned: PinnedEnclave;
  private repinning?: Promise<PinnedEnclave>;
  private readonly maxAttempts: number;

  private constructor(
    readonly url: string,
    private readonly portal: OxidePortalContract,
    private readonly timeouts: Timeouts,
    options: FleetSignerOptions,
    pinned: PinnedEnclave,
  ) {
    this.pinned = pinned;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  }

  /** Fetch an attestation from the fleet, verify it against the portal, and pin that enclave. */
  static async connect(
    url: string,
    portal: OxidePortalContract,
    options: FleetSignerOptions = {},
  ): Promise<FleetSigner> {
    const timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
    return new FleetSigner(url, portal, timeouts, options, await verifyAndPin(url, portal, timeouts));
  }

  /** The enclave currently serving this signer. Immutable, so it stays valid as an identity even after
   *  the fleet moves on. */
  get enclave(): PinnedEnclave {
    return this.pinned;
  }

  get attestation(): AttestationData {
    return this.pinned.attestation;
  }

  get publicKey(): SecpPublicKey {
    return this.pinned.publicKey;
  }

  get ethAddress(): EthAddress {
    return this.pinned.ethAddress;
  }

  get encryptionPublicKey(): P256PublicKey {
    return this.pinned.encryptionPublicKey;
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

  private async call<M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResult<M>> {
    let sealedRequest: SealedCall<M> | undefined = await this.pinned.prepare(method, params);
    let resentThisPin = false;
    let firstError: EnclaveUnavailable | undefined;
    let lastError: EnclaveUnavailable | undefined;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        // Re-pinning is part of the attempt, so its own failure spends the budget rather than escaping
        // and hiding why the operation actually failed.
        sealedRequest ??= await (await this.repin()).prepare(method, params);
        return await sealedRequest.send();
      } catch (err) {
        // An enclave's refusal is deterministic and a failed verification is not ours to paper over.
        if (!(err instanceof EnclaveUnavailable)) {
          throw err;
        }
        firstError ??= err;
        lastError = err;
        const step = nextStep(err, sealedRequest !== undefined, resentThisPin);
        if (step === 'stop') {
          throw err;
        }
        resentThisPin = step === 'resend';
        sealedRequest = step === 'resend' ? sealedRequest : undefined;
      }
    }

    throw new EnclaveUnavailable(
      `${method} failed after ${this.maxAttempts} attempts against the fleet at ${this.url} (last: ${lastError?.message})`,
      { status: firstError?.status, routerCode: firstError?.routerCode, cause: firstError },
    );
  }

  /** Concurrent failures share one re-pin, so N in-flight calls cost one attestation fetch and agree
   *  on the enclave they move to. */
  private repin(): Promise<PinnedEnclave> {
    this.repinning ??= verifyAndPin(this.url, this.portal, this.timeouts)
      .then(pinned => {
        this.pinned = pinned;
        return pinned;
      })
      .finally(() => {
        this.repinning = undefined;
      });
    return this.repinning;
  }
}

/**
 * Fetch an attestation and pin the enclave it names, having established that the portal registered
 * exactly these keys: the binding exists, its PCR0 is allow-listed, and all four public keys match.
 * Throws rather than returning a signer pointed at unverified key material.
 */
export async function verifyAndPin(
  url: string,
  portal: OxidePortalContract,
  timeouts: Timeouts,
): Promise<PinnedEnclave> {
  const attestation = await fetchUnverifiedAttestation(url, timeouts.attestationMs);
  const { publicKeyX, publicKeyY, encPubKeyX, encPubKeyY } = attestation.userData;
  const ethAddress = ethAddressFromSecpPublicKey({ x: publicKeyX, y: publicKeyY });

  const binding = await portal.getTeeBinding(ethAddress);
  if (!binding || binding.pcr0Hash.isZero()) {
    throw new Error(`TEE ${ethAddress} not registered in portal`);
  }
  if (!(await portal.isPcr0Approved(binding.pcr0Hash))) {
    throw new Error(`TEE ${ethAddress} PCR0 not approved in portal`);
  }
  if (
    !publicKeyX.equals(binding.keys.pubKeyX) ||
    !publicKeyY.equals(binding.keys.pubKeyY) ||
    !encPubKeyX.equals(binding.keys.encPubKeyX) ||
    !encPubKeyY.equals(binding.keys.encPubKeyY)
  ) {
    throw new Error(`TEE ${ethAddress} attestation does not match the data registered in the portal`);
  }
  return new PinnedEnclave(url, attestation, timeouts);
}

/**
 * What a failure is worth doing about.
 *
 * `no-tee-routable` is the fleet reporting it has no routable enclave at all, so there is nothing to
 * move to and no point spending the budget discovering that twice more — it returns on the timescale
 * of a host boot, which only the caller's retry loop can sensibly wait for. `tee-unknown` is narrower:
 * our own pin is gone, but other enclaves are presumably serving, so move. Anything else — a timeout, a
 * refused connection, an unreachable host — may be a blip worth resending the identical bytes once.
 */
function nextStep(err: EnclaveUnavailable, holdsPin: boolean, resentThisPin: boolean): 'resend' | 'repin' | 'stop' {
  if (err.routerCode === 'no-tee-routable') {
    return 'stop';
  }
  if (err.routerCode === 'tee-unknown') {
    return 'repin';
  }
  return holdsPin && !resentThisPin ? 'resend' : 'repin';
}

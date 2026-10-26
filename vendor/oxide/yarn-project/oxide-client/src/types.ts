import type { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import type { EthAddress } from '@aztec-labs/foundation/eth-address';

import type { OxidePortalContract } from '@oxide/l1-contracts';
import type { SecpPublicKey, SignTokenOperationOutput, TeeSigner, TokenOperation } from '@oxide/oxide-lib/types.js';

import type { ChainDataSource } from './chain_data_source.js';

/**
 * Per-submission context shared by the L1 finalize helpers.
 */
export interface L1SubmitContext {
  portal: OxidePortalContract;
  chain: ChainDataSource;
  signer: RegisteredTeeSigner;
  l2Token: AztecAddress;
}

/** A client-side handle to an enclave registered on a `TeeRegistry`. */
export interface RegisteredTeeSigner extends TeeSigner {
  readonly teeRegistry: EthAddress;
  signTokenOperation(operation: TokenOperation): Promise<RegisteredSignTokenOperationOutput>;
}

/**
 * The output plus the key and leaf index of the enclave that signed it. These can differ from the signer's current
 * ones, because a `FleetSigner` can switch enclaves at any time.
 */
export type RegisteredSignTokenOperationOutput = SignTokenOperationOutput & {
  publicKey: SecpPublicKey;
  registrationLeafIndex: bigint;
};

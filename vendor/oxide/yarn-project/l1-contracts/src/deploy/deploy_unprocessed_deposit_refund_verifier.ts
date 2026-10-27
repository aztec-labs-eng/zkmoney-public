import { deployL1Contract } from '@aztec-labs/ethereum/deploy-l1-contract';
import type { ExtendedViemWalletClient } from '@aztec-labs/ethereum/types';
import type { EthAddress } from '@aztec-labs/foundation/eth-address';

import {
  UnprocessedDepositRefundVerifierAbi,
  UnprocessedDepositRefundVerifierBytecode,
} from '../abis/UnprocessedDepositRefundVerifier.js';

/**
 * Deploys the auto-generated Honk verifier specialised for the `unprocessed_deposit_refund` circuit. This is the verifier
 * the portal calls from `refundUnprocessedDeposit`; pass its address as `unprocessedDepositRefundVerifier` in the
 * OxidePortal constructor.
 */
export async function deployUnprocessedDepositRefundVerifier(client: ExtendedViemWalletClient): Promise<EthAddress> {
  const { address } = await deployL1Contract(
    client,
    UnprocessedDepositRefundVerifierAbi,
    UnprocessedDepositRefundVerifierBytecode,
    [],
  );
  return address;
}

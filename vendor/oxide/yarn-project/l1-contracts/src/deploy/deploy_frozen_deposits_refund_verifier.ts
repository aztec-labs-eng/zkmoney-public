import { deployL1Contract } from '@aztec-labs/ethereum/deploy-l1-contract';
import type { ExtendedViemWalletClient } from '@aztec-labs/ethereum/types';
import type { EthAddress } from '@aztec-labs/foundation/eth-address';

import {
  FrozenDepositsRefundVerifierAbi,
  FrozenDepositsRefundVerifierBytecode,
} from '../abis/FrozenDepositsRefundVerifier.js';

/**
 * Deploys the auto-generated Honk verifier specialised for the `frozen_deposits_refund` circuit. This is the verifier
 * the portal calls from `refundFrozenDeposits`; pass its address as `frozenDepositsRefundVerifier` in the OxidePortal
 * constructor.
 */
export async function deployFrozenDepositsRefundVerifier(client: ExtendedViemWalletClient): Promise<EthAddress> {
  const { address } = await deployL1Contract(
    client,
    FrozenDepositsRefundVerifierAbi,
    FrozenDepositsRefundVerifierBytecode,
    [],
  );
  return address;
}

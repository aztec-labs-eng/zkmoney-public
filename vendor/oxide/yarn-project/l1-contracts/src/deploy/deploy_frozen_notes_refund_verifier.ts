import { deployL1Contract } from '@aztec-labs/ethereum/deploy-l1-contract';
import type { ExtendedViemWalletClient } from '@aztec-labs/ethereum/types';
import type { EthAddress } from '@aztec-labs/foundation/eth-address';

import { FrozenNotesRefundVerifierAbi, FrozenNotesRefundVerifierBytecode } from '../abis/FrozenNotesRefundVerifier.js';

/**
 * Deploys the auto-generated Honk verifier specialised for the `frozen_notes_refund` circuit. This is the verifier
 * the portal calls from `refundFrozenNotes`; pass its address as `frozenNotesRefundVerifier` in the OxidePortal
 * constructor.
 */
export async function deployFrozenNotesRefundVerifier(client: ExtendedViemWalletClient): Promise<EthAddress> {
  const { address } = await deployL1Contract(
    client,
    FrozenNotesRefundVerifierAbi,
    FrozenNotesRefundVerifierBytecode,
    [],
  );
  return address;
}

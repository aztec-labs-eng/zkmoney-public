import { deployL1Contract } from '@aztec/ethereum/deploy-l1-contract';
import type { ExtendedViemWalletClient } from '@aztec/ethereum/types';
import type { EthAddress } from '@aztec/foundation/eth-address';

import {
  UnprocessedDepositRefundVerifierAbi,
  UnprocessedDepositRefundVerifierBytecode,
  UnprocessedDepositRefundVerifierLinkReferences,
} from '../abis/UnprocessedDepositRefundVerifier.js';
import {
  UnprocessedDepositRelationsLibAbi,
  UnprocessedDepositRelationsLibBytecode,
} from '../abis/UnprocessedDepositRelationsLib.js';

/**
 * Deploys the auto-generated Honk verifier specialised for the
 * `unprocessed_deposit_refund` circuit. This is the verifier the portal calls from
 * `refundUnprocessedDeposit`; pass its address as `unprocessedDepositRefundVerifier` in the
 * OxidePortal constructor.
 *
 * The verifier delegates relation-evaluation accumulation to an `external pure` library
 * (`RelationsLib`) co-located in the same .sol file. The Solidity compiler emits the library as
 * a separate deployable contract and leaves a `__$<hash>$__` placeholder in the verifier bytecode;
 * `deployL1Contract` deploys the library first when `libraries` is provided and patches the
 * placeholder before sending the verifier deploy tx.
 */
export async function deployUnprocessedDepositRefundVerifier(client: ExtendedViemWalletClient): Promise<EthAddress> {
  const { address } = await deployL1Contract(
    client,
    UnprocessedDepositRefundVerifierAbi,
    UnprocessedDepositRefundVerifierBytecode,
    [],
    {
      libraries: {
        linkReferences: UnprocessedDepositRefundVerifierLinkReferences,
        libraryCode: {
          RelationsLib: {
            name: 'RelationsLib',
            contractAbi: UnprocessedDepositRelationsLibAbi,
            contractBytecode: UnprocessedDepositRelationsLibBytecode,
          },
        },
      },
    },
  );
  return address;
}

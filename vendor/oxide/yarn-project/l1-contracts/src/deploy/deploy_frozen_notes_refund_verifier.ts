import { deployL1Contract } from '@aztec/ethereum/deploy-l1-contract';
import type { ExtendedViemWalletClient } from '@aztec/ethereum/types';
import type { EthAddress } from '@aztec/foundation/eth-address';

import {
  FrozenNotesRefundVerifierAbi,
  FrozenNotesRefundVerifierBytecode,
  FrozenNotesRefundVerifierLinkReferences,
} from '../abis/FrozenNotesRefundVerifier.js';
import { FrozenNotesRelationsLibAbi, FrozenNotesRelationsLibBytecode } from '../abis/FrozenNotesRelationsLib.js';

/**
 * Deploys the auto-generated Honk verifier specialised for the
 * `frozen_notes_refund` circuit. This is the verifier the portal calls from
 * `refundFrozenNotes`; pass its address as `frozenNotesRefundVerifier` in the OxidePortal constructor.
 *
 * The verifier delegates relation-evaluation accumulation to an `external pure` library
 * (`RelationsLib`) co-located in the same .sol file. The Solidity compiler emits the library as
 * a separate deployable contract and leaves a `__$<hash>$__` placeholder in the verifier bytecode;
 * `deployL1Contract` deploys the library first when `libraries` is provided and patches the
 * placeholder before sending the verifier deploy tx.
 */
export async function deployFrozenNotesRefundVerifier(client: ExtendedViemWalletClient): Promise<EthAddress> {
  const { address } = await deployL1Contract(
    client,
    FrozenNotesRefundVerifierAbi,
    FrozenNotesRefundVerifierBytecode,
    [],
    {
      libraries: {
        linkReferences: FrozenNotesRefundVerifierLinkReferences,
        libraryCode: {
          RelationsLib: {
            name: 'RelationsLib',
            contractAbi: FrozenNotesRelationsLibAbi,
            contractBytecode: FrozenNotesRelationsLibBytecode,
          },
        },
      },
    },
  );
  return address;
}

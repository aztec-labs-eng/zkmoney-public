import type { AztecAddress } from '@aztec/aztec.js/addresses';

import type { OxidePortalContract } from '@oxide/l1-contracts';
import type { TeeSigner } from '@oxide/oxide-lib/types.js';

import type { ChainDataSource } from './chain_data_source.js';

/**
 * Per-submission context shared by the L1 finalize helpers.
 */
export interface L1SubmitContext {
  portal: OxidePortalContract;
  chain: ChainDataSource;
  signer: TeeSigner;
  l2Token: AztecAddress;
}

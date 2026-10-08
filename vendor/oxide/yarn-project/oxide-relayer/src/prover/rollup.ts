import { RollupContract } from '@aztec/ethereum/contracts/rollup';
import type { ViemClient } from '@aztec/ethereum/types';
import type { EthAddress } from '@aztec/foundation/eth-address';

import type { OxidePortalContract } from '@oxide/l1-contracts/oxide_portal.js';

import type { Hex } from 'viem';

/**
 * Creates the Aztec `RollupContract` on a relayer viem client. `ViemClient` requires a fallback HTTP transport and a
 * set chain, but the rollup reads use only `readContract`, which works on each relayer client.
 */
export function createRollupContract(client: OxidePortalContract['client'], address: Hex | EthAddress): RollupContract {
  return new RollupContract(client as ViemClient, address);
}

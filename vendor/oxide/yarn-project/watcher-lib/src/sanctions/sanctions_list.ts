import type { EthAddress } from '@aztec/foundation/eth-address';

export interface SanctionsList {
  isListed(address: EthAddress): boolean;
}

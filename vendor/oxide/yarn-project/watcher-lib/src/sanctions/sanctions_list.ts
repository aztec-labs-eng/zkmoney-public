import type { EthAddress } from '@aztec-labs/foundation/eth-address';

export interface SanctionsList {
  isListed(address: EthAddress): boolean;
}

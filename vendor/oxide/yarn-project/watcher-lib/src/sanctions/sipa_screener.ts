import type { EthAddress } from '@aztec/foundation/eth-address';

export type ScreenedSipa = { sipa: EthAddress };

export type FindFunders = (sipa: EthAddress) => Promise<EthAddress[]>;

export interface SipaScreener {
  isSanctioned(target: ScreenedSipa): Promise<boolean>;
}

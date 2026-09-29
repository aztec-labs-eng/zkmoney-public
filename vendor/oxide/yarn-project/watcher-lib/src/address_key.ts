import type { EthAddress } from '@aztec/foundation/eth-address';

/** Map/Set key for an address: lowercase hex, so a checksummed string and an `EthAddress` key the same entry. */
export function addressKey(address: EthAddress | string): string {
  return (typeof address === 'string' ? address : address.toString()).toLowerCase();
}

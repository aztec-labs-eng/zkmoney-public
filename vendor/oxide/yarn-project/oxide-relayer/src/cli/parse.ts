import { EthAddress } from '@aztec/foundation/eth-address';

/** Parse a comma-separated list of L1 addresses from CLI/env input. `label` names the option in errors. */
export function parseEthAddresses(value: string, label: string): EthAddress[] {
  const addresses = parseCsv(value).map(address => {
    if (!EthAddress.isAddress(address)) {
      throw new Error(`${label} has an invalid address: ${address}.`);
    }
    return EthAddress.fromString(address);
  });
  if (addresses.length === 0) {
    throw new Error(`${label} must include at least one address.`);
  }
  return addresses;
}

/** Parse comma-separated CLI/env list values. Empty segments are ignored so trailing commas are harmless. */
export function parseCsv(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(',')
    .map(v => v.trim())
    .filter(Boolean);
}

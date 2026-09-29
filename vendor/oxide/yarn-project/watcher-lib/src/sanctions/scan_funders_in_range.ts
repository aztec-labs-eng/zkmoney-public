import { EthAddress } from '@aztec/foundation/eth-address';

import { type PublicClient, parseAbiItem } from 'viem';

import { addressKey } from '../address_key.js';
import { scanWindows } from '../log_scan.js';

const TRANSFER_EVENT = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');

export interface ScanFundersInRangeOptions {
  client: PublicClient;
  tokens: EthAddress[];
  sipa: EthAddress;
  fromBlock: bigint;
  toBlock: bigint;
  /** Max blocks per `eth_getLogs` call; a window the provider caps is retried at half its span. */
  blocksPerQuery: bigint;
}

/** Distinct senders of every positive-value Transfer of `tokens` into `sipa` within `[fromBlock, toBlock]`. */
export async function scanFundersInRange({
  client,
  tokens,
  sipa,
  fromBlock,
  toBlock,
  blocksPerQuery,
}: ScanFundersInRangeOptions): Promise<EthAddress[]> {
  if (blocksPerQuery <= 0n) {
    throw new Error('blocks per query must be positive');
  }
  if (tokens.length === 0 || fromBlock > toBlock) {
    return [];
  }

  const funders = new Map<string, EthAddress>();
  const tokenAddresses = tokens.map(token => token.toString());
  const fetch = (start: bigint, end: bigint) =>
    client.getLogs({
      address: tokenAddresses,
      event: TRANSFER_EVENT,
      args: { to: sipa.toString() },
      fromBlock: start,
      toBlock: end,
      strict: true,
    });
  for await (const { logs } of scanWindows({ fromBlock, toBlock, window: blocksPerQuery }, fetch)) {
    for (const { args } of logs) {
      if (args.value > 0n) {
        funders.set(addressKey(args.from), EthAddress.fromString(args.from));
      }
    }
  }

  return [...funders.values()];
}

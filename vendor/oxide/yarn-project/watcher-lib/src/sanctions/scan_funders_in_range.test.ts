import { EthAddress } from '@aztec/foundation/eth-address';

import { describe, expect, it, jest } from '@jest/globals';
import type { Address, PublicClient } from 'viem';

import { scanFundersInRange } from './scan_funders_in_range.js';

const TOKEN_A = EthAddress.random();
const TOKEN_B = EthAddress.random();
const SIPA = EthAddress.random();
const FUNDER_A = EthAddress.random();
const FUNDER_B = EthAddress.random();

type TransferLog = { args: { from: Address; value: bigint }; blockNumber: bigint };

function transferLog(from: EthAddress, value: bigint, blockNumber: bigint): TransferLog {
  return { args: { from: from.toString(), value }, blockNumber };
}

function fakeClient(logs: TransferLog[] = [], rpcBlockLimit?: bigint) {
  const getLogs = jest.fn(({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
    if (rpcBlockLimit !== undefined && toBlock - fromBlock + 1n > rpcBlockLimit) {
      return Promise.reject(new Error('block range too large'));
    }
    return Promise.resolve(logs.filter(log => log.blockNumber >= fromBlock && log.blockNumber <= toBlock));
  });
  return { client: { getLogs } as unknown as PublicClient, getLogs };
}

function find(client: PublicClient, tokens = [TOKEN_A], range = { fromBlock: 1n, toBlock: 10n, blocksPerQuery: 5n }) {
  return scanFundersInRange({ client, tokens, sipa: SIPA, ...range });
}

describe('scanFundersInRange', () => {
  it('queries transfers into the SIPA and returns each positive-value funder once', async () => {
    const { client, getLogs } = fakeClient([
      transferLog(FUNDER_A, 1n, 2n),
      transferLog(FUNDER_A, 2n, 7n),
      transferLog(FUNDER_B, 3n, 10n),
    ]);

    await expect(find(client, [TOKEN_A, TOKEN_B])).resolves.toEqual([FUNDER_A, FUNDER_B]);
    expect(getLogs).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        address: [TOKEN_A.toString(), TOKEN_B.toString()],
        args: { to: SIPA.toString() },
        fromBlock: 1n,
        toBlock: 5n,
        strict: true,
      }),
    );
    expect(getLogs).toHaveBeenNthCalledWith(2, expect.objectContaining({ fromBlock: 6n, toBlock: 10n }));
  });

  it('ignores zero-value transfers that can attribute an arbitrary sender', async () => {
    const { client } = fakeClient([transferLog(FUNDER_A, 0n, 1n), transferLog(FUNDER_B, 1n, 2n)]);
    await expect(find(client)).resolves.toEqual([FUNDER_B]);
  });

  it('keeps every RPC request within the configured blocks per query', async () => {
    const { client, getLogs } = fakeClient([transferLog(FUNDER_A, 1n, 13n)], 5n);

    await expect(find(client, [TOKEN_A], { fromBlock: 3n, toBlock: 13n, blocksPerQuery: 5n })).resolves.toEqual([
      FUNDER_A,
    ]);
    expect(getLogs.mock.calls.map(([options]) => [options.fromBlock, options.toBlock])).toEqual([
      [3n, 7n],
      [8n, 12n],
      [13n, 13n],
    ]);
  });

  it('does not issue an unscoped query when no tokens are watched', async () => {
    const { client, getLogs } = fakeClient();
    await expect(find(client, [])).resolves.toEqual([]);
    expect(getLogs).not.toHaveBeenCalled();
  });

  it('rejects a non-positive blocks per query', async () => {
    const { client, getLogs } = fakeClient();
    await expect(find(client, [TOKEN_A], { fromBlock: 1n, toBlock: 2n, blocksPerQuery: 0n })).rejects.toThrow(
      'blocks per query must be positive',
    );
    expect(getLogs).not.toHaveBeenCalled();
  });

  it('propagates RPC failures instead of passing screening', async () => {
    const error = new Error('rpc down');
    const client = { getLogs: () => Promise.reject(error) } as unknown as PublicClient;
    await expect(find(client)).rejects.toBe(error);
  });
});

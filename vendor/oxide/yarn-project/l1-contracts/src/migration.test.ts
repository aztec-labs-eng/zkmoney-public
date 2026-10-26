import { describe, expect, it, jest } from '@jest/globals';
import { type Address, type Hex, type PublicClient, getAddress } from 'viem';

import {
  type DeploymentFeature,
  MigrationFlow,
  type MigrationSubsidyStatus,
  canMigrate,
  estimateMigrationSubsidy,
  findMigrationExecution,
  findMigrationFeature,
  migrationSubsidyStatus,
  readMigrationSubsidyState,
  readMigrationSubsidyStatus,
  readMigrationSubsidyTerms,
} from './migration.js';

const SOURCE_PORTAL = '0x1111111111111111111111111111111111111111' as Address;
const DESTINATION_PORTAL = '0x2222222222222222222222222222222222222222' as Address;
const EXECUTOR = '0x3333333333333333333333333333333333333333' as Address;
const SUBSIDY = '0x4444444444444444444444444444444444444444' as Address;
const DAI = '0x5555555555555555555555555555555555555555' as Address;
const FEED = '0x6666666666666666666666666666666666666666' as Address;
const OTHER_PORTAL = '0x7777777777777777777777777777777777777777' as Address;
const CODE_HASH = `0x${'ab'.repeat(32)}` as Hex;
const COMMITMENT = `0x${'01'.repeat(32)}` as Hex;
const TX_HASH = `0x${'cd'.repeat(32)}` as Hex;

function migrationFeature(sourcePortal: string, executor = EXECUTOR): DeploymentFeature {
  return {
    project: 'migration',
    bridges: { destination: 'brg-susds-v6' },
    contracts: { migrationExecutor: executor, migrationExecutorSubsidy: SUBSIDY },
    variables: { sourcePortal, payoutToken: DAI, operationExecutorCodeHash: CODE_HASH },
  };
}

describe('findMigrationFeature', () => {
  it('returns undefined when no feature serves the portal', () => {
    expect(findMigrationFeature(undefined, SOURCE_PORTAL)).toBeUndefined();
    expect(
      findMigrationFeature(
        {
          'fea-mig-other': migrationFeature(OTHER_PORTAL),
          'fea-sky': { ...migrationFeature(SOURCE_PORTAL), project: 'sky' },
        },
        SOURCE_PORTAL,
      ),
    ).toBeUndefined();
  });

  it('finds the one feature that serves the portal, ignoring the address case', () => {
    const features = {
      'fea-mig-other': migrationFeature(OTHER_PORTAL),
      'fea-mig-susds-v6': migrationFeature(getAddress(SOURCE_PORTAL).toUpperCase().replace('0X', '0x')),
    };
    expect(findMigrationFeature(features, SOURCE_PORTAL)).toEqual({
      id: 'fea-mig-susds-v6',
      executor: EXECUTOR,
      subsidy: SUBSIDY,
      payoutToken: DAI,
      destinationBridge: 'brg-susds-v6',
    });
  });

  it('throws when two features serve the portal', () => {
    const features = { a: migrationFeature(SOURCE_PORTAL), b: migrationFeature(SOURCE_PORTAL, OTHER_PORTAL) };
    expect(() => findMigrationFeature(features, SOURCE_PORTAL)).toThrow(/More than one migration feature.*a, b/);
  });

  it('throws when the matching feature misses its subsidy', () => {
    const feature = migrationFeature(SOURCE_PORTAL);
    const features = { a: { ...feature, contracts: { migrationExecutor: EXECUTOR } } };
    expect(() => findMigrationFeature(features, SOURCE_PORTAL)).toThrow(/migrationExecutorSubsidy/);
  });
});

function status(overrides: Partial<MigrationSubsidyStatus> = {}): MigrationSubsidyStatus {
  return {
    subsidy: SUBSIDY,
    token: DAI,
    tokenDecimals: 18,
    balance: 10n ** 21n,
    config: {
      targetRelayerProfit: 10n ** 17n,
      maxSubsidyPerOperation: 50n * 10n ** 18n,
      minMigratedAmount: 10n ** 18n,
    },
    sourcePortal: SOURCE_PORTAL,
    sourceFrozen: true,
    destinationPortal: DESTINATION_PORTAL,
    executor: EXECUTOR,
    operationExecutorCodeHash: CODE_HASH,
    gasCeilings: {
      withdrawal: 427_000n,
      frozenNotes: 3_110_000n,
      frozenDeposits: 2_760_000n,
      unprocessedDeposit: 2_830_000n,
    },
    freshBalanceGas: 17_100n,
    priceFeed: { address: FEED, answer: 2000n * 10n ** 8n, decimals: 8, updatedAt: 1_000n },
    ...overrides,
  };
}

describe('readMigrationSubsidyStatus', () => {
  it('reads the subsidy getters, the token balance, the portal freeze and the price feed', async () => {
    const subsidyValues: Record<string, unknown> = {
      TOKEN: DAI,
      TOKEN_DECIMALS: 18,
      $config: [1n, 2n, 3n],
      SOURCE_PORTAL,
      DESTINATION_PORTAL,
      EXECUTOR,
      OPERATION_EXECUTOR_CODEHASH: CODE_HASH,
      FRESH_BALANCE_GAS: 17_100n,
      PRICE_FEED: FEED,
    };
    const ceilings = [427_000n, 3_110_000n, 2_760_000n, 2_830_000n];
    const readContract = jest.fn(
      (request: { address: Address; functionName: string; args?: readonly unknown[] }): Promise<unknown> => {
        switch (request.functionName) {
          case 'migrationGasCeiling':
            return Promise.resolve(ceilings[request.args![0] as number]);
          case 'balanceOf':
            expect(request.address).toBe(DAI);
            expect(request.args).toEqual([SUBSIDY]);
            return Promise.resolve(7n);
          case '$frozen':
            expect(request.address).toBe(SOURCE_PORTAL);
            return Promise.resolve(true);
          case 'latestRoundData':
            expect(request.address).toBe(FEED);
            return Promise.resolve([1n, 3000n * 10n ** 8n, 0n, 99n, 1n]);
          case 'decimals':
            return Promise.resolve(8);
          default:
            expect(request.address).toBe(SUBSIDY);
            return Promise.resolve(subsidyValues[request.functionName]);
        }
      },
    );
    const publicClient = { readContract } as unknown as PublicClient;

    await expect(readMigrationSubsidyStatus(publicClient, SUBSIDY)).resolves.toEqual({
      subsidy: SUBSIDY,
      token: DAI,
      tokenDecimals: 18,
      balance: 7n,
      config: { targetRelayerProfit: 1n, maxSubsidyPerOperation: 2n, minMigratedAmount: 3n },
      sourcePortal: SOURCE_PORTAL,
      sourceFrozen: true,
      destinationPortal: DESTINATION_PORTAL,
      executor: EXECUTOR,
      operationExecutorCodeHash: CODE_HASH,
      gasCeilings: {
        withdrawal: 427_000n,
        frozenNotes: 3_110_000n,
        frozenDeposits: 2_760_000n,
        unprocessedDeposit: 2_830_000n,
      },
      freshBalanceGas: 17_100n,
      priceFeed: { address: FEED, answer: 3000n * 10n ** 8n, decimals: 8, updatedAt: 99n },
    });
  });
});

describe('readMigrationSubsidyTerms and readMigrationSubsidyState', () => {
  const terms = {
    subsidy: SUBSIDY,
    token: DAI,
    sourcePortal: SOURCE_PORTAL,
    priceFeed: { address: FEED, decimals: 8 },
  };

  it('batches the four state reads into one multicall when the client has one', async () => {
    const multicall = jest.fn((request: { contracts: readonly { functionName: string }[] }) => {
      expect(request.contracts.map(c => c.functionName)).toEqual([
        'balanceOf',
        '$config',
        '$frozen',
        'latestRoundData',
      ]);
      return Promise.resolve([7n, [1n, 2n, 3n], true, [1n, 3000n * 10n ** 8n, 0n, 99n, 1n]]);
    });
    const readContract = jest.fn();
    const publicClient = { readContract, multicall } as unknown as PublicClient;

    await expect(readMigrationSubsidyState(publicClient, terms)).resolves.toEqual({
      balance: 7n,
      config: { targetRelayerProfit: 1n, maxSubsidyPerOperation: 2n, minMigratedAmount: 3n },
      sourceFrozen: true,
      priceFeed: { answer: 3000n * 10n ** 8n, updatedAt: 99n },
    });
    expect(multicall).toHaveBeenCalledTimes(1);
    expect(readContract).not.toHaveBeenCalled();
  });

  it('falls back to single reads without a multicall', async () => {
    const readContract = jest.fn((request: { functionName: string }): Promise<unknown> => {
      switch (request.functionName) {
        case 'balanceOf':
          return Promise.resolve(7n);
        case '$config':
          return Promise.resolve([1n, 2n, 3n]);
        case '$frozen':
          return Promise.resolve(false);
        default:
          return Promise.resolve([1n, 3000n * 10n ** 8n, 0n, 99n, 1n]);
      }
    });
    const publicClient = { readContract } as unknown as PublicClient;
    const state = await readMigrationSubsidyState(publicClient, terms);
    expect(state.sourceFrozen).toBe(false);
    expect(readContract).toHaveBeenCalledTimes(4);
  });

  it('merges the terms and the state into the status', () => {
    const s = status();
    const { balance, config, sourceFrozen, priceFeed, ...rest } = s;
    const merged = migrationSubsidyStatus(
      { ...rest, priceFeed: { address: priceFeed.address, decimals: priceFeed.decimals } },
      { balance, config, sourceFrozen, priceFeed: { answer: priceFeed.answer, updatedAt: priceFeed.updatedAt } },
    );
    expect(merged).toEqual(s);
  });

  it('reads the terms one time without touching the state', async () => {
    const readContract = jest.fn((request: { functionName: string; args?: readonly unknown[] }): Promise<unknown> => {
      switch (request.functionName) {
        case 'migrationGasCeiling':
          return Promise.resolve(1n);
        case 'decimals':
          return Promise.resolve(8);
        case 'balanceOf':
        case '$config':
        case '$frozen':
        case 'latestRoundData':
          throw new Error(`state read ${request.functionName} in readMigrationSubsidyTerms`);
        default:
          return Promise.resolve(
            (
              {
                TOKEN: DAI,
                TOKEN_DECIMALS: 18,
                SOURCE_PORTAL,
                DESTINATION_PORTAL,
                EXECUTOR,
                OPERATION_EXECUTOR_CODEHASH: CODE_HASH,
                FRESH_BALANCE_GAS: 17_100n,
                PRICE_FEED: FEED,
              } as Record<string, unknown>
            )[request.functionName],
          );
      }
    });
    const publicClient = { readContract } as unknown as PublicClient;
    const read = await readMigrationSubsidyTerms(publicClient, SUBSIDY);
    expect(read.priceFeed).toEqual({ address: FEED, decimals: 8 });
    expect(read.gasCeilings.frozenNotes).toBe(1n);
  });
});

describe('estimateMigrationSubsidy', () => {
  it('prices the flow ceiling plus the fresh-balance gas at the feed price and adds the profit', () => {
    // (3_110_000 + 17_100) gas × 2 gwei = 0.0062542 ETH; × 2000 DAI/ETH = 12.5084 DAI; + 0.1 DAI profit.
    expect(
      estimateMigrationSubsidy(status(), { flow: MigrationFlow.FrozenNotesRefund, gasPriceWei: 2_000_000_000n }),
    ).toBe(12_608_400_000_000_000_000n);
  });

  it('uses the given ETH price and the token decimals', () => {
    // (427_000 + 17_100) gas × 1 gwei × 3000 USD/ETH = 1.3323 USD, in 6 decimals; + 0.1 USD profit.
    const usdc = status({ tokenDecimals: 6, config: { ...status().config, targetRelayerProfit: 100_000n } });
    expect(
      estimateMigrationSubsidy(usdc, { flow: MigrationFlow.Withdrawal, gasPriceWei: 1_000_000_000n, usdPerEth: 3000 }),
    ).toBe(1_432_300n);
  });

  it('caps the gas price at the base fee plus the maximum priority fee', () => {
    const capped = estimateMigrationSubsidy(status(), {
      flow: MigrationFlow.Withdrawal,
      gasPriceWei: 50_000_000_000n,
      baseFeeWei: 900_000_000n,
    });
    expect(capped).toBe(
      estimateMigrationSubsidy(status(), { flow: MigrationFlow.Withdrawal, gasPriceWei: 1_000_000_000n }),
    );
  });

  it('caps the payout at maxSubsidyPerOperation', () => {
    const config = { ...status().config, maxSubsidyPerOperation: 5n * 10n ** 18n };
    expect(
      estimateMigrationSubsidy(status({ config }), {
        flow: MigrationFlow.FrozenNotesRefund,
        gasPriceWei: 2_000_000_000n,
      }),
    ).toBe(5n * 10n ** 18n);
  });

  it('pays nothing at a negative feed price', () => {
    const priceFeed = { ...status().priceFeed, answer: -1n };
    expect(estimateMigrationSubsidy(status({ priceFeed }), { flow: MigrationFlow.Withdrawal, gasPriceWei: 1n })).toBe(
      0n,
    );
  });
});

describe('canMigrate', () => {
  const args = { flow: MigrationFlow.FrozenNotesRefund, migratedAmount: 10n ** 18n, gasPriceWei: 2_000_000_000n };

  it('accepts a migration that the subsidy pays', () => {
    expect(canMigrate(status(), { ...args, nowSeconds: 1_000n })).toEqual({ ok: true, reasons: [] });
  });

  it('lists each reason that the subsidy does not pay in full', () => {
    const result = canMigrate(status({ sourceFrozen: false, balance: 1n }), {
      ...args,
      migratedAmount: 10n ** 18n - 1n,
      nowSeconds: 1_000n + 3901n,
    });
    expect(result.ok).toBe(false);
    expect(result.reasons).toEqual([
      expect.stringMatching(/not frozen/),
      expect.stringMatching(/below the subsidy minimum/),
      expect.stringMatching(/stale/),
      expect.stringMatching(/balance 1 is below the estimated payout 12608400000000000000/),
    ]);
  });

  it('reports a subsidy without a config', () => {
    const config = { targetRelayerProfit: 0n, maxSubsidyPerOperation: 0n, minMigratedAmount: 0n };
    expect(canMigrate(status({ config }), { ...args, nowSeconds: 1_000n }).reasons).toEqual([
      expect.stringMatching(/pays nothing/),
    ]);
  });

  it('reports a price feed answer dated in the future', () => {
    const result = canMigrate(status(), { ...args, nowSeconds: 999n });
    expect(result.ok).toBe(false);
    expect(result.reasons).toEqual([expect.stringMatching(/dated in the future/)]);
  });

  it('accepts an answer at the maximum age and rejects one second older', () => {
    expect(canMigrate(status(), { ...args, nowSeconds: 1_000n + 3900n }).ok).toBe(true);
    expect(canMigrate(status(), { ...args, nowSeconds: 1_000n + 3901n }).reasons).toEqual([
      expect.stringMatching(/stale/),
    ]);
  });
});

describe('findMigrationExecution', () => {
  it('filters the Migrated events by the commitment and decodes the first one', async () => {
    const getLogs = jest.fn((_request: unknown) =>
      Promise.resolve([
        {
          transactionHash: TX_HASH,
          blockNumber: 12n,
          args: { flow: 1, recipientCommitment: COMMITMENT, migrated: 990n, tipRecipient: EXECUTOR, relayerTip: 10n },
        },
      ]),
    );
    const publicClient = { getLogs } as unknown as PublicClient;

    await expect(findMigrationExecution(publicClient, EXECUTOR, COMMITMENT, 5n)).resolves.toEqual({
      txHash: TX_HASH,
      blockNumber: 12n,
      flow: MigrationFlow.FrozenNotesRefund,
      migrated: 990n,
      relayerTip: 10n,
    });
    expect(getLogs).toHaveBeenCalledWith(
      expect.objectContaining({
        address: EXECUTOR,
        args: { recipientCommitment: COMMITMENT },
        fromBlock: 5n,
        toBlock: undefined,
        event: expect.objectContaining({ name: 'Migrated' }),
      }),
    );
  });

  it('returns undefined when no migration deposited under the commitment', async () => {
    const publicClient = { getLogs: () => Promise.resolve([]) } as unknown as PublicClient;
    await expect(findMigrationExecution(publicClient, EXECUTOR, COMMITMENT, 5n, 9n)).resolves.toBeUndefined();
  });
});

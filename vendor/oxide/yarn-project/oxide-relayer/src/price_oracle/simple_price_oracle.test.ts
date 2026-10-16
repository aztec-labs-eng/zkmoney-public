import { EthAddress } from '@aztec/foundation/eth-address';

import { priceFeedForChainId } from '@oxide/oxide-client/eth_usd_price_feed.js';

import { beforeEach, describe, expect, it } from '@jest/globals';
import { ContractFunctionExecutionError, ContractFunctionZeroDataError, erc4626Abi } from 'viem';

import { SimplePriceOracle } from './simple_price_oracle.js';

const USD = 10n ** 18n;
const CHAIN_ID = 1n;
const L1_TIMESTAMP = 1_700_000_000n;
const DAI = EthAddress.random();
const USDC = EthAddress.random();
const USDS = EthAddress.random();
const SUSDS = EthAddress.random();

interface FakeContract {
  /** `latestRoundData` answer, for a feed. */
  answer?: bigint;
  /** `decimals()`, for a token. */
  decimals?: number;
  /** `asset()`, for a vault. A token without it reverts. */
  asset?: EthAddress;
  /** `asset()` fails with this error in place of a revert. */
  assetError?: Error;
  /** Assets per whole share, for `convertToAssets`. */
  assetsPerShare?: bigint;
}

describe('SimplePriceOracle', () => {
  let contracts: Map<string, FakeContract>;
  let client: any;

  const set = (address: EthAddress, contract: FakeContract) =>
    contracts.set(address.toString().toLowerCase(), contract);

  beforeEach(() => {
    contracts = new Map();
    // $3000 per ETH, at the 8 decimals every Chainlink ETH/USD feed answers with.
    set(priceFeedForChainId(CHAIN_ID), { answer: 3_000n * 10n ** 8n });
    client = {
      readContract: ({ address, functionName, args }: { address: string; functionName: string; args?: bigint[] }) => {
        const contract = contracts.get(address.toLowerCase());
        if (!contract) {
          return Promise.reject(new Error(`no fake contract at ${address}`));
        }
        switch (functionName) {
          case 'latestRoundData':
            return Promise.resolve([1n, contract.answer!, 0n, L1_TIMESTAMP, 1n]);
          case 'decimals':
            return Promise.resolve(contract.decimals ?? 18);
          case 'asset':
            if (contract.assetError) {
              return Promise.reject(contract.assetError);
            }
            return contract.asset
              ? Promise.resolve(contract.asset.toString())
              : Promise.reject(
                  new ContractFunctionExecutionError(new ContractFunctionZeroDataError({ functionName: 'asset' }), {
                    abi: erc4626Abi,
                    functionName: 'asset',
                    contractAddress: address as `0x${string}`,
                  }),
                );
          case 'convertToAssets':
            return Promise.resolve((args![0] * contract.assetsPerShare!) / 10n ** BigInt(contract.decimals ?? 18));
          default:
            return Promise.reject(new Error(`unexpected call ${functionName}`));
        }
      },
      getBlock: () => Promise.resolve({ timestamp: L1_TIMESTAMP }),
    };
  });

  it('prices ETH with the chain feed, scaled to 18 decimals', async () => {
    const oracle = await SimplePriceOracle.create(client, { chainId: CHAIN_ID, tokens: [] });
    await expect(oracle.getEthPrice()).resolves.toBe(3_000n * USD);
  });

  it('prices a USD token at one USD, with its own decimals', async () => {
    set(DAI, { decimals: 18 });
    set(USDC, { decimals: 6 });
    const oracle = await SimplePriceOracle.create(client, { chainId: CHAIN_ID, tokens: [DAI, USDC] });
    await expect(oracle.getTokenPrice(DAI)).resolves.toEqual({ usdPerToken: USD, decimals: 18 });
    await expect(oracle.getTokenPrice(USDC)).resolves.toEqual({ usdPerToken: USD, decimals: 6 });
  });

  it('prices a vault share at its live rate over a USD asset', async () => {
    set(USDS, { decimals: 18 });
    set(SUSDS, { decimals: 18, asset: USDS, assetsPerShare: 105n * 10n ** 16n });
    const oracle = await SimplePriceOracle.create(client, { chainId: CHAIN_ID, tokens: [SUSDS] });
    await expect(oracle.getTokenPrice(SUSDS)).resolves.toEqual({ usdPerToken: 105n * 10n ** 16n, decimals: 18 });

    // The rate is read on every price, so yield shows up at once.
    set(SUSDS, { decimals: 18, asset: USDS, assetsPerShare: 106n * 10n ** 16n });
    await expect(oracle.getTokenPrice(SUSDS)).resolves.toEqual({ usdPerToken: 106n * 10n ** 16n, decimals: 18 });
  });

  it('scales the assets of a vault share with the decimals of the asset', async () => {
    set(USDC, { decimals: 6 });
    set(SUSDS, { decimals: 18, asset: USDC, assetsPerShare: 2n * 10n ** 6n });
    const oracle = await SimplePriceOracle.create(client, { chainId: CHAIN_ID, tokens: [SUSDS] });
    // One share is two whole USDC, at one USD each.
    await expect(oracle.getTokenPrice(SUSDS)).resolves.toEqual({ usdPerToken: 2n * USD, decimals: 18 });
  });

  it('refuses a vault that names itself as its asset', async () => {
    set(SUSDS, { decimals: 18, asset: SUSDS, assetsPerShare: USD });
    await expect(SimplePriceOracle.create(client, { chainId: CHAIN_ID, tokens: [SUSDS] })).rejects.toThrow(
      /names itself as its ERC-4626 asset/,
    );
  });

  it('fails on an RPC error from asset(), and does not take it as a USD token', async () => {
    set(SUSDS, { decimals: 18, assetError: new Error('rpc timeout') });
    await expect(SimplePriceOracle.create(client, { chainId: CHAIN_ID, tokens: [SUSDS] })).rejects.toThrow(
      'rpc timeout',
    );
  });

  it('refuses to price a token that it was not created with', async () => {
    const oracle = await SimplePriceOracle.create(client, { chainId: CHAIN_ID, tokens: [] });
    await expect(oracle.getTokenPrice(DAI)).rejects.toThrow(/has no price/);
  });

  it('describes each token for a startup log', async () => {
    set(DAI, { decimals: 18 });
    set(USDS, { decimals: 18 });
    set(SUSDS, { decimals: 18, asset: USDS, assetsPerShare: USD });
    const oracle = await SimplePriceOracle.create(client, { chainId: CHAIN_ID, tokens: [DAI, SUSDS] });
    expect(oracle.describe()).toEqual([
      `${DAI.toString().toLowerCase()} priced as a USD token at one USD`,
      `${SUSDS.toString().toLowerCase()} priced as an ERC-4626 share of a USD token, at the vault rate`,
    ]);
  });
});

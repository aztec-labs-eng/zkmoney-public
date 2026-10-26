import { EthAddress } from '@aztec-labs/foundation/eth-address';

import { ETH_USD_MAX_PRICE_AGE_SECONDS, priceFeedForChainId } from '@oxide/oxide-client/eth_usd_price_feed.js';

import { beforeEach, describe, expect, it } from '@jest/globals';
import {
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  erc4626Abi,
} from 'viem';

import { UsdPeggedPriceOracle } from './usd_pegged_price_oracle.js';

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
  /** `latestRoundData` update time, for a feed. The L1 timestamp when omitted. */
  updatedAt?: bigint;
  /** `decimals()`, for a token. */
  decimals?: number;
  /** `asset()`, for a vault. A token without it reverts. */
  asset?: EthAddress;
  /**
   * How `asset()` reverts on a token without it: with no data, as on a contract without code, or as `execution
   * reverted`, as on a contract without the function, for example the USDS token. No data when omitted.
   */
  assetRevert?: 'zero-data' | 'reverted';
  /** `asset()` fails with this error in place of a revert. */
  assetError?: Error;
  /** Assets per whole share, for `convertToAssets`. */
  assetsPerShare?: bigint;
}

describe('UsdPeggedPriceOracle', () => {
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
            return Promise.resolve([1n, contract.answer!, 0n, contract.updatedAt ?? L1_TIMESTAMP, 1n]);
          case 'decimals':
            return Promise.resolve(contract.decimals ?? 18);
          case 'asset':
            if (contract.assetError) {
              return Promise.reject(contract.assetError);
            }
            return contract.asset
              ? Promise.resolve(contract.asset.toString())
              : Promise.reject(
                  new ContractFunctionExecutionError(
                    contract.assetRevert === 'reverted'
                      ? new ContractFunctionRevertedError({ abi: erc4626Abi, functionName: 'asset' })
                      : new ContractFunctionZeroDataError({ functionName: 'asset' }),
                    { abi: erc4626Abi, functionName: 'asset', contractAddress: address as `0x${string}` },
                  ),
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
    const oracle = await UsdPeggedPriceOracle.create(client, { chainId: CHAIN_ID, tokens: [] });
    await expect(oracle.getEthPrice()).resolves.toBe(3_000n * USD);
  });

  it('refuses to price ETH with a stale feed answer', async () => {
    set(priceFeedForChainId(CHAIN_ID), {
      answer: 3_000n * 10n ** 8n,
      updatedAt: L1_TIMESTAMP - ETH_USD_MAX_PRICE_AGE_SECONDS - 1n,
    });
    const oracle = await UsdPeggedPriceOracle.create(client, { chainId: CHAIN_ID, tokens: [] });
    await expect(oracle.getEthPrice()).rejects.toThrow(/stale/);
  });

  it('prices a USD token at one USD, with its own decimals', async () => {
    set(DAI, { decimals: 18 });
    set(USDC, { decimals: 6 });
    const oracle = await UsdPeggedPriceOracle.create(client, { chainId: CHAIN_ID, tokens: [DAI, USDC] });
    await expect(oracle.getTokenPrice(DAI)).resolves.toEqual({ usdPerToken: USD, decimals: 18 });
    await expect(oracle.getTokenPrice(USDC)).resolves.toEqual({ usdPerToken: USD, decimals: 6 });
  });

  it('prices a vault share at its live rate over a USD asset', async () => {
    set(USDS, { decimals: 18 });
    set(SUSDS, { decimals: 18, asset: USDS, assetsPerShare: 105n * 10n ** 16n });
    const oracle = await UsdPeggedPriceOracle.create(client, { chainId: CHAIN_ID, tokens: [SUSDS] });
    await expect(oracle.getTokenPrice(SUSDS)).resolves.toEqual({ usdPerToken: 105n * 10n ** 16n, decimals: 18 });

    // The rate is read on every price, so yield shows up at once.
    set(SUSDS, { decimals: 18, asset: USDS, assetsPerShare: 106n * 10n ** 16n });
    await expect(oracle.getTokenPrice(SUSDS)).resolves.toEqual({ usdPerToken: 106n * 10n ** 16n, decimals: 18 });
  });

  it('prices a vault share whose asset reverts on asset() as a USD token, as the staging sUSDS mock over USDS does', async () => {
    set(USDS, { decimals: 18, assetRevert: 'reverted' });
    set(SUSDS, { decimals: 18, asset: USDS, assetsPerShare: USD });
    const oracle = await UsdPeggedPriceOracle.create(client, { chainId: CHAIN_ID, tokens: [SUSDS, USDS] });
    await expect(oracle.getTokenPrice(SUSDS)).resolves.toEqual({ usdPerToken: USD, decimals: 18 });
    await expect(oracle.getTokenPrice(USDS)).resolves.toEqual({ usdPerToken: USD, decimals: 18 });
  });

  it('scales the assets of a vault share with the decimals of the asset', async () => {
    set(USDC, { decimals: 6 });
    set(SUSDS, { decimals: 18, asset: USDC, assetsPerShare: 2n * 10n ** 6n });
    const oracle = await UsdPeggedPriceOracle.create(client, { chainId: CHAIN_ID, tokens: [SUSDS] });
    // One share is two whole USDC, at one USD each.
    await expect(oracle.getTokenPrice(SUSDS)).resolves.toEqual({ usdPerToken: 2n * USD, decimals: 18 });
  });

  it('refuses a vault that names itself as its asset', async () => {
    set(SUSDS, { decimals: 18, asset: SUSDS, assetsPerShare: USD });
    await expect(UsdPeggedPriceOracle.create(client, { chainId: CHAIN_ID, tokens: [SUSDS] })).rejects.toThrow(
      /names itself as its ERC-4626 asset/,
    );
  });

  it('fails on an RPC error from asset(), and does not take it as a USD token', async () => {
    set(SUSDS, { decimals: 18, assetError: new Error('rpc timeout') });
    await expect(UsdPeggedPriceOracle.create(client, { chainId: CHAIN_ID, tokens: [SUSDS] })).rejects.toThrow(
      'rpc timeout',
    );
  });

  it('refuses to price a token that was not added', async () => {
    const oracle = await UsdPeggedPriceOracle.create(client, { chainId: CHAIN_ID, tokens: [] });
    await expect(oracle.getTokenPrice(DAI)).rejects.toThrow(/has no price/);
  });

  it('prices a token that is added after it is created', async () => {
    set(USDS, { decimals: 18 });
    set(SUSDS, { decimals: 18, asset: USDS, assetsPerShare: 105n * 10n ** 16n });
    const oracle = await UsdPeggedPriceOracle.create(client, { chainId: CHAIN_ID, tokens: [] });
    await oracle.addToken(SUSDS);
    await expect(oracle.getTokenPrice(SUSDS)).resolves.toEqual({ usdPerToken: 105n * 10n ** 16n, decimals: 18 });
  });

  it('classifies an added token only once', async () => {
    set(DAI, { decimals: 18 });
    const oracle = await UsdPeggedPriceOracle.create(client, { chainId: CHAIN_ID, tokens: [DAI] });
    // A second classification would read the 6 decimals.
    set(DAI, { decimals: 6 });
    await oracle.addToken(DAI);
    await expect(oracle.getTokenPrice(DAI)).resolves.toEqual({ usdPerToken: USD, decimals: 18 });
  });

  it('adds nothing when it cannot classify an added token', async () => {
    set(SUSDS, { decimals: 18, asset: SUSDS, assetsPerShare: USD });
    const oracle = await UsdPeggedPriceOracle.create(client, { chainId: CHAIN_ID, tokens: [] });
    await expect(oracle.addToken(SUSDS)).rejects.toThrow(/names itself as its ERC-4626 asset/);
    expect(oracle.describe()).toEqual([]);
  });

  it('describes each token for a startup log', async () => {
    set(DAI, { decimals: 18 });
    set(USDS, { decimals: 18 });
    set(SUSDS, { decimals: 18, asset: USDS, assetsPerShare: USD });
    const oracle = await UsdPeggedPriceOracle.create(client, { chainId: CHAIN_ID, tokens: [DAI, SUSDS] });
    expect(oracle.describe()).toEqual([
      `${DAI.toString().toLowerCase()} priced as a USD token at one USD`,
      `${SUSDS.toString().toLowerCase()} priced as an ERC-4626 share of a USD token, at the vault rate`,
    ]);
  });
});

import { EthAddress } from '@aztec/foundation/eth-address';

import { describe, expect, test } from '@jest/globals';

import {
  MAINNET_CHAIN_ID,
  MAINNET_DAI,
  MAINNET_DEPOSIT_TOKENS,
  MAINNET_USDC,
  MAINNET_USDT,
  depositPayoutTokenFor,
  depositTokensFor,
} from './deposit_tokens.js';

const SEPOLIA = 11_155_111n;
const TEST_TOKEN = EthAddress.fromString('0x1111111111111111111111111111111111111111');

describe('deposit tokens', () => {
  test('mainnet accepts the swap inputs, other chains only the portal underlying', () => {
    expect(depositTokensFor(MAINNET_CHAIN_ID, MAINNET_DAI)).toEqual(MAINNET_DEPOSIT_TOKENS);
    expect(depositTokensFor(SEPOLIA, TEST_TOKEN)).toEqual([TEST_TOKEN]);
  });

  test('a swept mainnet swap input pays out in DAI, everything else in the sent token', () => {
    expect(depositPayoutTokenFor(MAINNET_CHAIN_ID, MAINNET_USDC).equals(MAINNET_DAI)).toBe(true);
    expect(depositPayoutTokenFor(MAINNET_CHAIN_ID, MAINNET_USDT).equals(MAINNET_DAI)).toBe(true);
    expect(depositPayoutTokenFor(MAINNET_CHAIN_ID, MAINNET_DAI).equals(MAINNET_DAI)).toBe(true);
    expect(depositPayoutTokenFor(SEPOLIA, TEST_TOKEN).equals(TEST_TOKEN)).toBe(true);
  });
});

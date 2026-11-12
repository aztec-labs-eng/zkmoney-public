import { EthAddress } from '@aztec-labs/foundation/eth-address';

import { describe, expect, test } from '@jest/globals';

import {
  MAINNET_CHAIN_ID,
  MAINNET_DAI,
  MAINNET_DEPOSIT_TOKENS,
  MAINNET_USDC,
  MAINNET_USDT,
  depositPayoutTokenFor,
  depositTokensFor,
  sweepTokensFor,
} from './deposit_tokens.js';

const SEPOLIA = 11_155_111n;
const TEST_TOKEN = EthAddress.fromString('0x1111111111111111111111111111111111111111');
const OTHER_TOKEN = EthAddress.fromString('0x2222222222222222222222222222222222222222');
/** A mainnet token that no SIPA swaps, as sUSDS. */
const UNSWAPPED_TOKEN = EthAddress.fromString('0x3333333333333333333333333333333333333333');

/** The tokens as a sorted list of lowercase addresses, because the order of the watched tokens is not part of the rule. */
const asSet = (tokens: EthAddress[]) => tokens.map(token => token.toString().toLowerCase()).sort();

describe('deposit tokens', () => {
  test('mainnet accepts the swap inputs, other chains only the portal underlying', () => {
    expect(depositTokensFor(MAINNET_CHAIN_ID, MAINNET_DAI)).toEqual(MAINNET_DEPOSIT_TOKENS);
    expect(depositTokensFor(SEPOLIA, TEST_TOKEN)).toEqual([TEST_TOKEN]);
  });

  test('a mainnet sweep of USDC or USDT pays out in DAI', () => {
    expect(depositPayoutTokenFor(MAINNET_CHAIN_ID, MAINNET_USDC).equals(MAINNET_DAI)).toBe(true);
    expect(depositPayoutTokenFor(MAINNET_CHAIN_ID, MAINNET_USDT).equals(MAINNET_DAI)).toBe(true);
  });

  test('every other sweep pays out in the sent token', () => {
    expect(depositPayoutTokenFor(MAINNET_CHAIN_ID, MAINNET_DAI).equals(MAINNET_DAI)).toBe(true);
    expect(depositPayoutTokenFor(SEPOLIA, TEST_TOKEN).equals(TEST_TOKEN)).toBe(true);
  });
});

describe('sweepTokensFor', () => {
  test('on mainnet, a relayer that accepts DAI watches DAI, USDC and USDT, and each other accepted token', () => {
    expect(asSet(sweepTokensFor(MAINNET_CHAIN_ID, [MAINNET_DAI, UNSWAPPED_TOKEN]))).toEqual(
      asSet([MAINNET_DAI, MAINNET_USDC, MAINNET_USDT, UNSWAPPED_TOKEN]),
    );
  });

  test('on mainnet, a relayer that does not accept DAI watches no USDC, because a USDC sweep pays in DAI', () => {
    expect(sweepTokensFor(MAINNET_CHAIN_ID, [MAINNET_USDC, UNSWAPPED_TOKEN])).toEqual([UNSWAPPED_TOKEN]);
  });

  test('on other chains, a relayer watches each accepted token', () => {
    expect(sweepTokensFor(SEPOLIA, [TEST_TOKEN, OTHER_TOKEN])).toEqual([TEST_TOKEN, OTHER_TOKEN]);
  });
});

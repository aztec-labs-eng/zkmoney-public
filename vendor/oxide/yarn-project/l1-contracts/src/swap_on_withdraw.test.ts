import { describe, expect, test } from '@jest/globals';
import { type Hex, encodeFunctionData } from 'viem';

import {
  type LegacySwapEscrowArgs,
  LegacySwapEscrowFactoryAbi,
  SwapRoute,
  encodeLegacySwapEscrowArgs,
  encodeLegacySwapEscrowDeploy,
  predictLegacySwapEscrowAddressLocally,
  predictSwapEscrowAddressLocally,
} from './swap_on_withdraw.js';

// The `swapEscrowFactory` of the prod manifest. Its `predictEscrowAddress` returns LEGACY_ESCROW for LEGACY_ARGS.
const LEGACY_FACTORY = '0x03b21bba8e75a1bd0354c5ecbec078cf59c85343';
const LEGACY_ARGS: LegacySwapEscrowArgs = {
  route: SwapRoute.USDC,
  recipient: '0x1111111111111111111111111111111111111111',
  recoveryCommitment: `0x${'22'.repeat(32)}`,
  relayerTip: 1234567890123456789n,
  nonce: `0x${'33'.repeat(32)}`,
};
const LEGACY_ESCROW = '0x989bF68BCd5EBF60655AD10e45d7d182f5Afe6b0';
// The encoding of LEGACY_ARGS before `SwapEscrow.Args` got `daiForGas` and `minEthForGas`.
const LEGACY_ENCODED_ARGS = ('0x' +
  '0'.repeat(64) +
  '0'.repeat(24) +
  '11'.repeat(20) +
  '22'.repeat(32) +
  '112210f47de98115'.padStart(64, '0') +
  '33'.repeat(32)) as Hex;

describe('legacy swap escrow layout', () => {
  test('encodes the args as the legacy factory does', () => {
    expect(encodeLegacySwapEscrowArgs(LEGACY_ARGS)).toBe(LEGACY_ENCODED_ARGS);
  });

  test('predicts the escrow address of the legacy factory', () => {
    expect(predictLegacySwapEscrowAddressLocally(LEGACY_FACTORY, LEGACY_ARGS)).toBe(LEGACY_ESCROW);
  });

  test('encodes the legacy factory calls', () => {
    const body = LEGACY_ENCODED_ARGS.slice(2);
    expect(encodeLegacySwapEscrowDeploy(LEGACY_ARGS)).toBe(`0xd1cb17ef${body}`);
    expect(encodeFunctionData({ abi: LegacySwapEscrowFactoryAbi, functionName: 'deploy', args: [LEGACY_ARGS] })).toBe(
      `0xebd3470d${body}`,
    );
  });

  test('the current layout derives another escrow from the same values', () => {
    const current = predictSwapEscrowAddressLocally(LEGACY_FACTORY, {
      ...LEGACY_ARGS,
      daiForGas: 0n,
      minEthForGas: 0n,
    });
    expect(current).not.toBe(LEGACY_ESCROW);
  });
});

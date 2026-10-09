import { describe, expect, it } from '@jest/globals';
import { type Hex, decodeFunctionData, encodeAbiParameters } from 'viem';

import {
  type SkyEscrowArgs,
  SkyEscrowFactoryAbi,
  SkyRoute,
  encodeSkyEscrowArgs,
  encodeSkyEscrowDeploy,
} from './sky_savings.js';

const args: SkyEscrowArgs = {
  route: SkyRoute.Unstake,
  recipientCommitment: `0x${'ab'.repeat(32)}` as Hex,
  recoveryCommitment: `0x00${'cd'.repeat(31)}` as Hex,
  relayerTip: 123n,
  nonce: `0x${'ef'.repeat(32)}` as Hex,
};

describe('Sky escrow args', () => {
  it('encode as the factory ABI encodes its Args struct', () => {
    const predict = SkyEscrowFactoryAbi.find(item => item.type === 'function' && item.name === 'predictEscrowAddress');
    if (!predict || predict.type !== 'function') {
      throw new Error('SkyEscrowFactory has no predictEscrowAddress');
    }
    expect(encodeSkyEscrowArgs(args)).toBe(encodeAbiParameters(predict.inputs, [args]));
  });

  it('deploy and run the escrow they commit to', () => {
    const call = decodeFunctionData({ abi: SkyEscrowFactoryAbi, data: encodeSkyEscrowDeploy(args) });
    expect(call.functionName).toBe('deployAndExecute');
    expect(call.args).toEqual([args]);
  });
});

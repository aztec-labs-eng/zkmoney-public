import { describe, expect, test } from '@jest/globals';
import { decodeFunctionData } from 'viem';

import { MakerPsmAdapterAbi } from '../../artifacts.js';
import { type Psm, makerPsmSteps } from './maker_psm.js';

describe('makerPsm.buyGem', () => {
  const makerPsm = makerPsmSteps({ address: '0x9000000000000000000000000000000000000001' });
  const psm = {
    address: '0x7000000000000000000000000000000000000001',
    stable: '0x1000000000000000000000000000000000000001',
    gem: '0x2000000000000000000000000000000000000002',
  } satisfies Psm;
  const recipient = '0x1111111111111111111111111111111111111111';

  test('takes the stable, pays the gem, and encodes the PSM, the amount, the bound and the recipient', () => {
    const step = makerPsm.buyGem({ psm, minOut: 5n });
    expect([step.in, step.out]).toEqual([psm.stable, psm.gem]);
    expect(decodeFunctionData({ abi: MakerPsmAdapterAbi, data: step.encode({ amount: 7n, recipient }) })).toEqual({
      functionName: 'psmBuyGem',
      args: [psm.address, 7n, 5n, recipient],
    });
  });
});

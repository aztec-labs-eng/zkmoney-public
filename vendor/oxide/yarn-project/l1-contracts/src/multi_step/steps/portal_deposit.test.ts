import { describe, expect, test } from '@jest/globals';
import { decodeFunctionData } from 'viem';

import { PortalDepositAdapterAbi } from '../../artifacts.js';
import { portalDepositSteps } from './portal_deposit.js';

describe('portalDeposit', () => {
  const portalDeposit = portalDepositSteps({ address: '0x9000000000000000000000000000000000000001' });
  const portal = {
    address: '0x9300000000000000000000000000000000000001',
    asset: '0x1000000000000000000000000000000000000001',
  } as const;
  const recipientCommitment = `0x${'11'.repeat(32)}` as const;

  test('deposit takes the asset of the portal and encodes the portal, the amount and the commitment', () => {
    const step = portalDeposit.deposit({ portal, recipientCommitment });
    expect(step.in).toEqual(portal.asset);
    expect(decodeFunctionData({ abi: PortalDepositAdapterAbi, data: step.encode({ amount: 7n }) })).toEqual({
      functionName: 'portalDeposit',
      args: [portal.address, 7n, recipientCommitment],
    });
  });
});

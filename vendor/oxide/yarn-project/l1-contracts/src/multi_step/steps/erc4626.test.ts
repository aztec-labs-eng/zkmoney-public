import { describe, expect, test } from '@jest/globals';
import { decodeFunctionData } from 'viem';

import { ERC4626AdapterAbi } from '../../artifacts.js';
import { type Vault, erc4626Steps } from './erc4626.js';

describe('erc4626', () => {
  const erc4626 = erc4626Steps({ address: '0x9000000000000000000000000000000000000001' });
  const vault = {
    asset: '0x5000000000000000000000000000000000000005',
    share: '0x6000000000000000000000000000000000000006',
  } satisfies Vault;
  const recipient = '0x1111111111111111111111111111111111111111';

  test('deposit takes the asset, pays the share, and encodes the vault, the amount, the bound and the recipient', () => {
    const step = erc4626.deposit({ vault, minOut: 5n });
    expect([step.in, step.out]).toEqual([vault.asset, vault.share]);
    expect(decodeFunctionData({ abi: ERC4626AdapterAbi, data: step.encode({ amount: 7n, recipient }) })).toEqual({
      functionName: 'erc4626Deposit',
      args: [vault.share, 7n, 5n, recipient],
    });
  });

  test('redeem takes the share, pays the asset, and encodes the vault, the amount, the bound and the recipient', () => {
    const step = erc4626.redeem({ vault, minOut: 5n });
    expect([step.in, step.out]).toEqual([vault.share, vault.asset]);
    expect(decodeFunctionData({ abi: ERC4626AdapterAbi, data: step.encode({ amount: 7n, recipient }) })).toEqual({
      functionName: 'erc4626Redeem',
      args: [vault.share, 7n, 5n, recipient],
    });
  });
});

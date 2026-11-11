import type { Address } from 'viem';

import { ERC4626AdapterAbi } from '../../artifacts.js';
import { type AdapterConfig, adapterSteps } from './step.js';

export type Vault<Asset extends Address = Address, Share extends Address = Address> = {
  asset: Asset;
  // A vault is its own share token
  share: Share;
};

export function erc4626Steps(c: AdapterConfig) {
  const define = adapterSteps(c.address, ERC4626AdapterAbi);
  return {
    ...c,
    deposit<Asset extends Address, Share extends Address>(p: { vault: Vault<Asset, Share>; minOut: bigint }) {
      return define.step({
        fn: 'erc4626Deposit',
        in: p.vault.asset,
        out: p.vault.share,
        minOut: p.minOut,
        args: s => [p.vault.share, s.amount, p.minOut, s.recipient] as const,
      });
    },

    redeem<Asset extends Address, Share extends Address>(p: { vault: Vault<Asset, Share>; minOut: bigint }) {
      return define.step({
        fn: 'erc4626Redeem',
        in: p.vault.share,
        out: p.vault.asset,
        minOut: p.minOut,
        args: s => [p.vault.share, s.amount, p.minOut, s.recipient] as const,
      });
    },
  };
}

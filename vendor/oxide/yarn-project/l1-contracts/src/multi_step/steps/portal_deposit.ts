import type { Address, Hex } from 'viem';

import { PortalDepositAdapterAbi } from '../../artifacts.js';
import { type AdapterConfig, adapterSteps } from './step.js';

export type Portal<Asset extends Address = Address> = {
  address: Address;
  asset: Asset;
};

export function portalDepositSteps(c: AdapterConfig) {
  const define = adapterSteps(c.address, PortalDepositAdapterAbi);
  return {
    ...c,
    deposit<Asset extends Address>(p: { portal: Portal<Asset>; recipientCommitment: Hex }) {
      return define.noPayout({
        fn: 'portalDeposit',
        in: p.portal.asset,
        args: s => [p.portal.address, s.amount, p.recipientCommitment] as const,
      });
    },
  };
}

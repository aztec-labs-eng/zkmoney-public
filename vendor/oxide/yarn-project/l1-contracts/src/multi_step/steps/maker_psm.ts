import type { Address } from 'viem';

import { MakerPsmAdapterAbi } from '../../artifacts.js';
import { type AdapterConfig, adapterSteps } from './step.js';

export type Psm<Stable extends Address = Address, Gem extends Address = Address> = {
  address: Address;
  // DAI or USDS, by PSM
  stable: Stable;
  gem: Gem;
};

export function makerPsmSteps(c: AdapterConfig) {
  const define = adapterSteps(c.address, MakerPsmAdapterAbi);
  return {
    ...c,
    /** Sells `stable` for `gem`. */
    buyGem<Stable extends Address, Gem extends Address>(p: { psm: Psm<Stable, Gem>; minOut: bigint }) {
      return define.step({
        fn: 'psmBuyGem',
        in: p.psm.stable,
        out: p.psm.gem,
        minOut: p.minOut,
        args: s => [p.psm.address, s.amount, p.minOut, s.recipient] as const,
      });
    },
  };
}

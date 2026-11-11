import type { Address } from 'viem';

import { SkyConverterAdapterAbi } from '../../artifacts.js';
import { adapterSteps } from './step.js';

export type SkyConverterConfig<Dai extends Address = Address, Usds extends Address = Address> = {
  address: Address;
  dai: Dai;
  usds: Usds;
};

export function skyConverterSteps<Dai extends Address, Usds extends Address>(c: SkyConverterConfig<Dai, Usds>) {
  const define = adapterSteps(c.address, SkyConverterAdapterAbi);
  return {
    ...c,
    daiToUsds() {
      return define.step({ fn: 'daiToUsds', in: c.dai, out: c.usds, args: s => [s.amount, s.recipient] as const });
    },

    usdsToDai() {
      return define.step({ fn: 'usdsToDai', in: c.usds, out: c.dai, args: s => [s.amount, s.recipient] as const });
    },
  };
}

import type { Address } from 'viem';

import { WethAdapterAbi } from '../../artifacts.js';
import { ETH, adapterSteps } from './step.js';

export type WethConfig<Weth extends Address = Address> = { address: Address; weth: Weth };

export function wethSteps<Weth extends Address>(c: WethConfig<Weth>) {
  const define = adapterSteps(c.address, WethAdapterAbi);
  return {
    ...c,
    unwrap() {
      return define.step({ fn: 'unwrapWeth', in: c.weth, out: ETH, args: s => [s.amount, s.recipient] as const });
    },

    wrap() {
      return define.step({ fn: 'wrapEth', in: ETH, out: c.weth, args: s => [s.amount, s.recipient] as const });
    },
  };
}

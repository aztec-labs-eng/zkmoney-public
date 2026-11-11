import { type Address, isAddressEqual } from 'viem';

import { CurveAdapterAbi } from '../../artifacts.js';
import { type AdapterConfig, adapterSteps } from './step.js';

/** `coins[i]` is the pool's `coins(i)`. */
export type CurvePool<Coin extends Address = Address> = {
  address: Address;
  coins: readonly Coin[];
};

export function curveSteps(c: AdapterConfig) {
  const define = adapterSteps(c.address, CurveAdapterAbi);
  return {
    ...c,
    exchange<Coin extends Address, From extends Coin, To extends Coin>(p: {
      pool: CurvePool<Coin>;
      from: From;
      to: To;
      minOut: bigint;
    }) {
      const i = coinIndex(p.pool, p.from);
      const j = coinIndex(p.pool, p.to);
      if (i === j) {
        throw new Error(`curve.exchange: from and to are the same coin (${p.from})`);
      }
      return define.step({
        fn: 'curveExchange',
        in: p.from,
        out: p.to,
        minOut: p.minOut,
        args: s => [p.pool.address, i, j, s.amount, p.minOut, s.recipient] as const,
      });
    },
  };
}

function coinIndex(pool: CurvePool, coin: Address) {
  const index = pool.coins.findIndex(c => isAddressEqual(c, coin));
  if (index < 0) {
    throw new Error(`curve.exchange: ${coin} is not a coin of the pool ${pool.address}`);
  }
  return BigInt(index);
}

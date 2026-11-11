import { type Address, concatHex, isAddressEqual, numberToHex, zeroAddress } from 'viem';

import { UniswapV3AdapterAbi } from '../../artifacts.js';
import { type AdapterConfig, adapterSteps } from './step.js';

/** Each hop names the pool fee and the token it pays. */
export type UniswapV3Path<In extends Address = Address, Out extends Address = Address> = {
  tokenIn: In;
  hops: readonly [...UniswapV3Hop[], UniswapV3Hop<Out>];
};

export type UniswapV3Hop<Out extends Address = Address> = {
  /** Hundredths of a basis point: 500 is 0.05%. */
  fee: number;
  tokenOut: Out;
};

export function uniswapV3Steps(c: AdapterConfig) {
  const define = adapterSteps(c.address, UniswapV3AdapterAbi);
  return {
    ...c,
    exactIn<In extends Address, Out extends Address>(p: { path: UniswapV3Path<In, Out>; minOut: bigint }) {
      return define.step({
        fn: 'uniswapV3ExactIn',
        in: p.path.tokenIn,
        out: lastHop(p.path).tokenOut,
        minOut: p.minOut,
        args: s => [encodeUniswapV3Path(p.path), s.amount, p.minOut, s.recipient] as const,
      });
    },

    /** Exactly `amountOut`, and `leftoverRecipient` gets the unspent input. */
    exactOut<In extends Address, Out extends Address>(p: {
      path: UniswapV3Path<In, Out>;
      amountOut: bigint;
      leftoverRecipient: Address;
    }) {
      if (isAddressEqual(p.leftoverRecipient, zeroAddress)) {
        throw new Error('leftoverRecipient must not be zero');
      }
      // Uniswap reads an exact-out path from output to input.
      const reversed = packedParts(p.path).reverse();
      return define.step({
        fn: 'uniswapV3ExactOut',
        in: p.path.tokenIn,
        out: lastHop(p.path).tokenOut,
        minOut: p.amountOut,
        args: s => [pack(reversed), p.amountOut, s.amount, s.recipient, p.leftoverRecipient] as const,
      });
    },
  };
}

/** Token, 3-byte fee, token, and so on, as the router reads it. */
function encodeUniswapV3Path(path: UniswapV3Path) {
  return pack(packedParts(path));
}

function lastHop<Out extends Address>(path: UniswapV3Path<Address, Out>): UniswapV3Hop<Out> {
  return path.hops[path.hops.length - 1] as UniswapV3Hop<Out>;
}

function packedParts(path: UniswapV3Path): (Address | number)[] {
  return [path.tokenIn, ...path.hops.flatMap(hop => [hop.fee, hop.tokenOut])];
}

function pack(parts: readonly (Address | number)[]) {
  return concatHex(parts.map(part => (typeof part === 'number' ? numberToHex(part, { size: 3 }) : part)));
}

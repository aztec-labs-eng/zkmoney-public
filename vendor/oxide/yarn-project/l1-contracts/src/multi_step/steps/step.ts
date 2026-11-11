import {
  type Abi,
  type Address,
  type ContractFunctionArgs,
  type ContractFunctionName,
  type EncodeFunctionDataParameters,
  type Hex,
  encodeFunctionData,
} from 'viem';

/** Zero min amount out, named so a route reads as a choice. */
export const UNBOUNDED = 0n;

/** The address that stands for ETH in a route. */
export const ETH: Address = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

export type AdapterConfig = { address: Address };

/** The chain of the executor and of every adapter. */
export type Chain = { chainId: bigint };

/** What the route decides for a step. */
export type Flow = {
  amount: bigint;
  recipient: Address;
};

export type Step<In extends Address = Address, Out extends Address = Address> = {
  readonly adapter: Address;
  readonly fn: string;
  readonly in: In;
  readonly out: Out;
  /** Undefined when the adapter call has no bound to set, so there is nothing to protect here. */
  readonly minOut?: bigint;
  encode(flow: Flow): Hex;
};

/** Names its own destination and closes the lane. */
export type TerminalStep<In extends Address = Address> = {
  readonly adapter: Address;
  readonly fn: string;
  readonly in: In;
  readonly out?: undefined;
  readonly minOut?: bigint;
  encode(flow: Pick<Flow, 'amount'>): Hex;
};

export type AnyStep = Step | TerminalStep;

export function adapterSteps<const abi extends Abi>(adapter: Address, abi: abi) {
  type Fn = ContractFunctionName<abi, 'nonpayable'>;
  type Args<fn extends Fn> = ContractFunctionArgs<abi, 'nonpayable', fn>;
  const encode = <fn extends Fn>(fn: fn, args: Args<fn>) =>
    encodeFunctionData({ abi, functionName: fn, args } as EncodeFunctionDataParameters);
  return {
    step<fn extends Fn, In extends Address, Out extends Address>(s: {
      fn: fn;
      in: In;
      out: Out;
      minOut?: bigint;
      args: (flow: Flow) => Args<fn>;
    }): Step<In, Out> {
      return {
        adapter,
        fn: s.fn,
        in: s.in,
        out: s.out,
        minOut: s.minOut,
        encode: flow => encode(s.fn, s.args(flow)),
      };
    },
    terminal<fn extends Fn, In extends Address>(s: {
      fn: fn;
      in: In;
      minOut?: bigint;
      args: (flow: Pick<Flow, 'amount'>) => Args<fn>;
    }): TerminalStep<In> {
      return { adapter, fn: s.fn, in: s.in, minOut: s.minOut, encode: flow => encode(s.fn, s.args(flow)) };
    },
  };
}

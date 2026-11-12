import {
  type Abi,
  type Address,
  type ContractFunctionArgs,
  type ContractFunctionName,
  type EncodeFunctionDataParameters,
  type Hex,
  encodeFunctionData,
  zeroAddress,
} from 'viem';

/** Zero min amount out, named so a route reads as a choice. */
export const UNBOUNDED = 0n;

/** The address that stands for ETH in a route. */
export const ETH: Address = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

/**
 * The token of a lane that holds none. A step that pays nothing on L1 puts out `NO_TOKEN`. Its literal type lets the
 * compiler refuse `to` on such a lane.
 */
export const NO_TOKEN = zeroAddress;
export type NO_TOKEN = typeof NO_TOKEN;

export type AdapterConfig = { address: Address };

/** The chain of the executor and of every adapter. */
export type Chain = { chainId: bigint };

/** What the route decides for a step. A step that puts out `NO_TOKEN` ignores the recipient. */
export type Flow = {
  amount: bigint;
  recipient: Address;
};

/** One adapter call: takes `In`, pays `Out` to the recipient. */
export type Step<In extends Address = Address, Out extends Address = Address> = {
  readonly adapter: Address;
  readonly fn: string;
  readonly in: In;
  readonly out: Out;
  /** Undefined when the adapter call has no bound to set, so there is nothing to protect here. */
  readonly minOut?: bigint;
  encode(flow: Flow): Hex;
};

export function adapterSteps<const abi extends Abi>(adapter: Address, abi: abi) {
  type Fn = ContractFunctionName<abi, 'nonpayable' | 'view'>;
  type Args<fn extends Fn> = ContractFunctionArgs<abi, 'nonpayable' | 'view', fn>;
  const encode = <fn extends Fn>(fn: fn, args: Args<fn>) =>
    encodeFunctionData({ abi, functionName: fn, args } as EncodeFunctionDataParameters);
  type Definition<fn extends Fn, In extends Address, Out extends Address> = {
    fn: fn;
    in: In;
    out: Out;
    minOut?: bigint;
    args: (flow: Flow) => Args<fn>;
  };
  type NoPayoutDefinition<fn extends Fn, In extends Address> = Omit<Definition<fn, In, NO_TOKEN>, 'out'>;
  const step = <fn extends Fn, In extends Address, Out extends Address>(s: Definition<fn, In, Out>): Step<In, Out> => ({
    adapter,
    fn: s.fn,
    in: s.in,
    out: s.out,
    minOut: s.minOut,
    encode: flow => encode(s.fn, s.args(flow)),
  });
  return {
    step,
    /** A step that pays nothing on L1, so it puts out `NO_TOKEN`. */
    noPayout<fn extends Fn, In extends Address>(s: NoPayoutDefinition<fn, In>) {
      return step({ ...s, out: NO_TOKEN });
    },
  };
}

import type { Address, Hex } from 'viem';

import { AcrossAdapterAbi } from '../../artifacts.js';
import { type AdapterConfig, adapterSteps } from './step.js';

export type AcrossDeposit<In extends Address = Address> = {
  inputToken: In;
  destinationChainId: bigint;
  outputToken: Address;
  outputDecimals: number;
  recipient: Address;
  /** In input token units. */
  fee: bigint;
  /** Refunded on L1 when no relayer fills. */
  refundTo: Address;
  /** Seconds after the deposit opens on L1 until it expires. */
  fillDeadlineOffset: number;
};

export function acrossSteps(c: AdapterConfig) {
  const define = adapterSteps(c.address, AcrossAdapterAbi);
  return {
    ...c,
    deposit<In extends Address>({ refundTo, ...p }: AcrossDeposit<In>) {
      return define.terminal({
        fn: 'acrossDeposit',
        in: p.inputToken,
        args: s => [{ ...p, depositor: refundTo, amount: s.amount }] as const,
      });
    },

    depositWithMessage<In extends Address>({ refundTo, ...p }: AcrossDeposit<In> & { message: Hex }) {
      return define.terminal({
        fn: 'acrossDepositWithMessage',
        in: p.inputToken,
        args: s => [{ ...p, depositor: refundTo, amount: s.amount }] as const,
      });
    },
  };
}

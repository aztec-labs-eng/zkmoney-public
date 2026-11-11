import { type Address, type Hex, pad } from 'viem';

import { CctpAdapterAbi } from '../../artifacts.js';
import type { CctpFinality } from '../../cctp_bridge_on_withdraw.js';
import { adapterSteps } from './step.js';

export type CctpConfig<Usdc extends Address = Address> = { address: Address; usdc: Usdc };

export type CctpDeposit = {
  destinationDomain: number;
  recipient: Address;
  /** In USDC units. */
  maxFee: bigint;
  minFinalityThreshold: CctpFinality;
};

/** `hook.target` gets the USDC and alone can receive the message, so it runs `hook.calldata`. */
export type CctpDepositWithHook = Omit<CctpDeposit, 'recipient'> & {
  hook: { target: Address; calldata: Hex };
};

export function cctpSteps<Usdc extends Address>(c: CctpConfig<Usdc>) {
  const define = adapterSteps(c.address, CctpAdapterAbi);
  return {
    ...c,
    deposit(p: CctpDeposit) {
      return define.terminal({
        fn: 'cctpDeposit',
        in: c.usdc,
        args: s => [s.amount, p.destinationDomain, mintRecipient(p), p.maxFee, p.minFinalityThreshold] as const,
      });
    },

    depositWithHook(p: CctpDepositWithHook) {
      const target = pad(p.hook.target, { size: 32 });
      return define.terminal({
        fn: 'cctpDepositWithHook',
        in: c.usdc,
        args: s =>
          [s.amount, p.destinationDomain, target, target, p.maxFee, p.minFinalityThreshold, p.hook.calldata] as const,
      });
    },
  };
}

// CCTP addresses are 32 bytes, left-padded.
function mintRecipient(p: Pick<CctpDeposit, 'recipient'>) {
  return pad(p.recipient, { size: 32 });
}

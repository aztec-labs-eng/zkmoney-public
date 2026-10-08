import type { EthAddress } from '@aztec/foundation/eth-address';

import { type SwapEscrowArgs, type SwapRoute, encodeSwapEscrowArgs, encodeSwapEscrowDeploy } from '@oxide/l1-contracts';

import { type EscrowWithdrawal, type EscrowWithdrawalArgs, buildEscrowWithdrawal } from './escrow_withdrawal.js';

export interface SwapOnWithdrawArgs extends EscrowWithdrawalArgs {
  swapEscrowFactory: EthAddress;
  route: SwapRoute;
  /** Final L1 recipient of the swap output (must accept ETH on the ETH route). */
  l1Recipient: EthAddress;
}

export type SwapOnWithdraw = EscrowWithdrawal<SwapEscrowArgs>;

/** Builds the withdrawal to a counterfactual `SwapEscrow`, and the L1 operation that deploys it and runs the swap. */
export function buildSwapOnWithdraw(args: SwapOnWithdrawArgs): SwapOnWithdraw {
  return buildEscrowWithdrawal(
    ({ nonce, recoveryCommitment }) => {
      const escrowArgs: SwapEscrowArgs = {
        route: args.route,
        recipient: args.l1Recipient.toString(),
        recoveryCommitment,
        relayerTip: args.relayerTip,
        nonce,
      };
      return {
        escrowArgs,
        encodedArgs: encodeSwapEscrowArgs(escrowArgs),
        deployCalldata: encodeSwapEscrowDeploy(escrowArgs),
      };
    },
    { args, factory: args.swapEscrowFactory },
  );
}

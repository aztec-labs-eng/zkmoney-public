import type { EthAddress } from '@aztec/foundation/eth-address';

import {
  MAX_DAI_FOR_GAS,
  type SwapEscrowArgs,
  SwapRoute,
  encodeSwapEscrowArgs,
  encodeSwapEscrowDeploy,
  predictSwapEscrowAddress,
} from '@oxide/l1-contracts';

import type { PublicClient } from 'viem';

import {
  type EscrowFundingArgs,
  type EscrowWithdrawal,
  type EscrowWithdrawalArgs,
  buildEscrowWithdrawal,
  checkedEscrowFunding,
} from './escrow_withdrawal.js';

export interface SwapOnWithdrawArgs extends EscrowWithdrawalArgs {
  /** The factory under the `swapEscrowFactoryV2` key of the deployment manifest: it takes `daiForGas`. */
  swapEscrowFactoryV2: EthAddress;
  route: SwapRoute;
  /** Final L1 recipient of the swap output. It must accept ETH on the ETH route, and when `daiForGas` is above 0. */
  l1Recipient: EthAddress;
  /**
   * DAI that the escrow swaps to ETH for `l1Recipient` before the route. At most `MAX_DAI_FOR_GAS` and at most the escrow
   * funding after `relayerTip`. Defaults to 0.
   */
  daiForGas?: bigint;
  /**
   * The least ETH that the `daiForGas` swap must pay, else the escrow reverts. It must be 0 when `daiForGas` is 0.
   * Defaults to 0.
   */
  minEthForGas?: bigint;
}

export type SwapOnWithdraw = EscrowWithdrawal<SwapEscrowArgs>;

/** Builds the withdrawal to a counterfactual `SwapEscrow`, and the L1 operation that deploys it and runs the swap. */
export function buildSwapOnWithdraw(args: SwapOnWithdrawArgs): SwapOnWithdraw {
  const { daiForGas = 0n, minEthForGas = 0n } = args;
  assertSwapOnWithdraw({ ...args, daiForGas, minEthForGas });
  return buildEscrowWithdrawal(
    ({ nonce, recoveryCommitment }) => {
      const escrowArgs: SwapEscrowArgs = {
        route: args.route,
        recipient: args.l1Recipient.toString(),
        daiForGas,
        minEthForGas,
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
    { args, factory: args.swapEscrowFactoryV2 },
  );
}

/**
 * Throws unless the factory of `swap` predicts `swap.escrow`. Call it before you send the L2 withdrawal. A factory with
 * an older `Args` layout, such as the one under the `swapEscrowFactory` manifest key, reverts here. It could never deploy
 * the escrow, so the withdrawn DAI would be lost.
 */
export async function assertSwapEscrowDeployable(
  publicClient: Pick<PublicClient, 'readContract'>,
  swap: Pick<SwapOnWithdraw, 'escrow' | 'escrowArgs' | 'l1Operation'>,
): Promise<void> {
  const factory = swap.l1Operation.target;
  let predicted: string;
  try {
    predicted = await predictSwapEscrowAddress(publicClient, factory.toString(), swap.escrowArgs);
  } catch (err) {
    throw new Error(`the swap escrow factory ${factory} did not confirm the escrow ${swap.escrow}`, { cause: err });
  }
  if (predicted.toLowerCase() !== swap.escrow.toString().toLowerCase()) {
    throw new Error(`the swap escrow factory ${factory} predicts ${predicted}, not the escrow ${swap.escrow}`);
  }
}

function assertSwapOnWithdraw(
  args: Pick<SwapOnWithdrawArgs, 'route' | 'l1Recipient'> &
    EscrowFundingArgs & { daiForGas: bigint; minEthForGas: bigint },
): void {
  if (args.l1Recipient.isZero()) {
    throw new Error('l1Recipient must not be the zero address');
  }
  if (args.daiForGas < 0n || args.daiForGas > MAX_DAI_FOR_GAS) {
    throw new Error(`daiForGas (${args.daiForGas}) must be between 0 and MAX_DAI_FOR_GAS (${MAX_DAI_FOR_GAS})`);
  }
  if (args.daiForGas > 0n && args.route === SwapRoute.ETH) {
    throw new Error('daiForGas must be 0 on the ETH route, which already pays ETH');
  }
  if (args.minEthForGas < 0n) {
    throw new Error(`minEthForGas (${args.minEthForGas}) must not be negative`);
  }
  if (args.minEthForGas > 0n && args.daiForGas === 0n) {
    throw new Error('minEthForGas must be 0 when daiForGas is 0, because the escrow then does no gas swap');
  }
  const fundingAfterTip = checkedEscrowFunding(args) - args.relayerTip;
  if (args.daiForGas > fundingAfterTip) {
    throw new Error(
      `daiForGas (${args.daiForGas}) must not exceed the escrow funding after relayerTip (${fundingAfterTip})`,
    );
  }
}

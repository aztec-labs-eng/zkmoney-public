import type { EthAddress } from '@aztec/foundation/eth-address';

import {
  type EscrowWithdrawal,
  type EscrowWithdrawalArgs,
  buildEscrowWithdrawal,
} from '@oxide/oxide-client/withdraw_escrows/escrow_withdrawal.js';

import type { Hex } from 'viem';

import { type SkyEscrowArgs, type SkyRoute, encodeSkyEscrowArgs, encodeSkyEscrowDeploy } from './sky_savings.js';

export interface SkyEscrowWithdrawalArgs extends Omit<EscrowWithdrawalArgs, 'plainWithdrawalExecutor'> {
  skyEscrowFactory: EthAddress;
  route: SkyRoute;
  /** The secret hash of the deposit the escrow makes into the destination portal. */
  recipientCommitment: Hex;
  /**
   * The source portal's executor, which must deliver DAI to the escrow: the plain withdrawal executor for a stake
   * from the DAI portal, and the `SkyWithdrawalExecutor` for an unstake from the sUSDS portal, which redeems the
   * shares to DAI. The escrow's run waits for DAI, so an executor that forwards shares leaves it waiting.
   */
  withdrawalExecutor: EthAddress;
}

export type SkyEscrowWithdrawal = EscrowWithdrawal<SkyEscrowArgs>;

/** Builds the withdrawal to a counterfactual `SkyEscrow`, and the L1 operation that deploys it and runs its route. */
export function buildSkyEscrowWithdrawal(args: SkyEscrowWithdrawalArgs): SkyEscrowWithdrawal {
  return buildEscrowWithdrawal(
    ({ nonce, recoveryCommitment }) => {
      const escrowArgs: SkyEscrowArgs = {
        route: args.route,
        recipientCommitment: args.recipientCommitment,
        recoveryCommitment,
        relayerTip: args.relayerTip,
        nonce,
      };
      return {
        escrowArgs,
        encodedArgs: encodeSkyEscrowArgs(escrowArgs),
        deployCalldata: encodeSkyEscrowDeploy(escrowArgs),
      };
    },
    { args: { ...args, plainWithdrawalExecutor: args.withdrawalExecutor }, factory: args.skyEscrowFactory },
  );
}

import type { EthAddress } from '@aztec-labs/aztec.js/addresses';

import { type BroadcastL1Operation, L1OperationCondition } from '@oxide/oxide-lib/l1_operation_calldata.js';

import type { Hex } from 'viem';

/** The inputs of `buildMigrationOperation`. */
export interface MigrationOperationArgs {
  /**
   * The `MigrationSubsidy` of the old portal: `contracts.migrationExecutorSubsidy` of the migration feature. The
   * operation targets it. The subsidy forwards the calldata to the old portal without a change, and then pays the
   * relayer of the migration.
   */
  subsidy: EthAddress;
  /**
   * The token that the subsidy pays the relayer in: `variables.payoutToken` of the migration feature, which is the
   * `TOKEN` of the subsidy. The subsidy pays only when it is the payout token of the operation.
   */
  payoutToken: EthAddress;
  /**
   * The calldata of the old portal that names the `MigrationExecutor`, for example from
   * `buildRefundFrozenNotesCalldata`, `buildRefundFrozenDepositCalldata` or `buildRefundUnprocessedDepositCalldata`.
   */
  calldata: Hex;
}

/**
 * The L1 operation that migrates funds from an old portal to the new portal through `MigrationExecutor`. Any relayer
 * can execute it at once. The operation calls the migration subsidy, not the old portal: a call straight to the old
 * portal also migrates, but the relayer gets no subsidy.
 */
export function buildMigrationOperation(args: MigrationOperationArgs): BroadcastL1Operation {
  return {
    target: args.subsidy,
    payoutToken: args.payoutToken,
    calldata: Buffer.from(args.calldata.slice(2), 'hex'),
    condition: L1OperationCondition.immediate(),
  };
}

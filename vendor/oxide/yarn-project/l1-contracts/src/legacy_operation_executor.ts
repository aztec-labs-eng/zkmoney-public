import { parseAbi } from 'viem';

/** `OperationExecutor.execute` of deployments from before it took `gasToCover` and `tokenWeiPerEth`. */
export const LegacyOperationExecutorAbi = parseAbi([
  'function execute(address target, bytes data, address payoutToken, uint256 minPayout) returns (uint256 payout)',
]);

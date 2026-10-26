import { type Address, type PublicClient, getAbiItem, parseAbi, toFunctionSelector } from 'viem';

import { OperationExecutorAbi } from './abis/OperationExecutor.js';

/** `OperationExecutor.execute` of deployments from before it took `gasToCover` and `tokenWeiPerEth`. */
export const LegacyOperationExecutorAbi = parseAbi([
  'function execute(address target, bytes data, address payoutToken, uint256 minPayout) returns (uint256 payout)',
]);

/**
 * The `execute` that an `OperationExecutor` deployment has:
 * - `legacy`: `execute(target, data, payoutToken, minPayout)`.
 * - `gas-to-cover`: `execute(target, data, payoutToken, minPayout, gasToCover, tokenWeiPerEth)`.
 */
export type OperationExecutorVersion = 'legacy' | 'gas-to-cover';

/** Reads the `execute` version of the executor at `executor` from the function selectors in its code. */
export async function readOperationExecutorVersion(
  client: Pick<PublicClient, 'getCode'>,
  executor: Address,
): Promise<OperationExecutorVersion> {
  const code = (await client.getCode({ address: executor }))?.toLowerCase() ?? '0x';
  const has = (abi: typeof OperationExecutorAbi | typeof LegacyOperationExecutorAbi) =>
    code.includes(toFunctionSelector(getAbiItem({ abi, name: 'execute' })).slice(2));
  if (has(OperationExecutorAbi)) {
    return 'gas-to-cover';
  }
  if (has(LegacyOperationExecutorAbi)) {
    return 'legacy';
  }
  throw new Error(`no OperationExecutor execute function in the code at ${executor}`);
}

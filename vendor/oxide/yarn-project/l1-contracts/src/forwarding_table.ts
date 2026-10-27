import { type Address, BaseError, ContractFunctionRevertedError, type PublicClient } from 'viem';

import { ForwardingTableAbi } from './artifacts.js';
import type { SipaIntent } from './sipa_factory.js';

/** `ForwardingTable.rowFor(token, intent)`: where a sweep of `token` for `intent` goes, and what it pays. */
export interface ForwardingTableRow {
  portal: Address;
  beneficiary: Address;
  beneficiaryFee: bigint;
  sweepTip: bigint;
}

/**
 * The row of `token` for `intent` in `forwardingTable`. Undefined when the table does not list the token or the
 * intent: a sweep of that token reverts, and the funds stay in the SIPA for recovery.
 */
export async function readForwardingTableRow(
  publicClient: PublicClient,
  forwardingTable: Address,
  token: Address,
  intent: SipaIntent,
): Promise<ForwardingTableRow | undefined> {
  try {
    const [portal, beneficiary, beneficiaryFee, sweepTip] = (await publicClient.readContract({
      address: forwardingTable,
      abi: ForwardingTableAbi,
      functionName: 'rowFor',
      args: [token, intent],
    } as any)) as [Address, Address, bigint, bigint];
    return { portal, beneficiary, beneficiaryFee, sweepTip };
  } catch (err) {
    if (err instanceof BaseError && err.walk(e => e instanceof ContractFunctionRevertedError)) {
      return undefined;
    }
    throw err;
  }
}

import { retryUntil } from '@aztec/foundation/retry';

import type { Hex, TransactionReceipt } from 'viem';

export interface WriteOptions {
  waitForReceipt?: boolean;
  /** Explicit gas limit. Set it when `eth_estimateGas` cannot be trusted for the call. */
  gas?: bigint;
}

export interface ContractWriteResult {
  txHash: Hex;
  receipt: TransactionReceipt | undefined;
}

/** Keeps `PublicClient` and `ExtendedViemWalletClient` assignable despite differing viem generics. */
export interface ReceiptClient {
  waitForTransactionReceipt(args: { hash: Hex }): Promise<TransactionReceipt>;
  getBlockNumber(args?: { cacheTime?: number }): Promise<bigint>;
}

/** Without `waitForReceipt`, returns just the tx hash. With it, awaits the receipt, throws on revert, and waits for
 *  the RPC head to reach the receipt's block. A load-balanced RPC can return the receipt from one node while a
 *  different node, one block behind, answers the next call. The wait makes sure that follow-up reads see the written
 *  state. */
export async function maybeWaitForReceipt(
  client: ReceiptClient,
  txHash: Hex,
  options: WriteOptions,
): Promise<ContractWriteResult> {
  if (!options.waitForReceipt) {
    return { txHash, receipt: undefined };
  }
  const receipt = await client.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== 'success') {
    throw new Error(`L1 tx ${txHash} reverted in block ${receipt.blockNumber}`);
  }
  await retryUntil(
    async () => (await client.getBlockNumber({ cacheTime: 0 })) >= receipt.blockNumber,
    `RPC head at block ${receipt.blockNumber}`,
    30,
    0.25,
  );
  return { txHash, receipt };
}

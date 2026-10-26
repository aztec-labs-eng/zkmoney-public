import { retryUntil } from '@aztec-labs/foundation/retry';

import type {
  Abi,
  Account,
  Chain,
  ContractFunctionArgs,
  ContractFunctionName,
  Hex,
  PublicActions,
  TransactionReceipt,
  Transport,
  WalletClient,
  WriteContractParameters,
} from 'viem';

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

/**
 * The gas limit for an estimate: 3/2 of it. `eth_estimateGas` gives the lowest limit that does not revert in the
 * state at estimation. The state can change before inclusion and make the call cost more, for example when an Inbox
 * message opens a new bucket or when a storage slot changes from zero. A limit that is too high costs nothing,
 * because a tx pays only for the gas that it uses.
 */
export function padGasEstimate(estimate: bigint): bigint {
  return (estimate * 3n) / 2n;
}

type WriteMutability = 'nonpayable';

/**
 * Sends a contract write with the gas limit in `options`, or else with {@link padGasEstimate} of an estimate. Then
 * continues as {@link maybeWaitForReceipt}.
 */
export async function writeWithGasLimit<
  const abi extends Abi,
  functionName extends ContractFunctionName<abi, WriteMutability>,
>(
  client: WalletClient<Transport, Chain, Account> & PublicActions,
  request: {
    address: Hex;
    abi: abi;
    functionName: functionName;
    args: ContractFunctionArgs<abi, WriteMutability, functionName>;
  },
  options: WriteOptions,
): Promise<ContractWriteResult> {
  const call = { ...request, account: client.account };
  const gas = options.gas ?? padGasEstimate(await client.estimateContractGas(call));
  // viem cannot infer the write parameters of a generic function name.
  const txHash = await client.writeContract({ ...call, chain: client.chain, gas } as WriteContractParameters<
    abi,
    functionName
  >);
  return await maybeWaitForReceipt(client, txHash, options);
}

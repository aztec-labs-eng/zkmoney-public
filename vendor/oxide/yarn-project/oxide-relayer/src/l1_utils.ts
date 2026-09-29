import type { AztecNode } from '@aztec/aztec.js/node';
import { getPublicClient as createPublicClient } from '@aztec/ethereum/client';
import type { ViemPublicClient } from '@aztec/ethereum/types';

/**
 * Gas to add to an executor gas estimate before it becomes the gas limit of the sent transaction. The estimate runs
 * against `minPayout = 0` calldata (32 zero bytes at 4 gas each) while the sent transaction has a non-zero
 * `minPayout` (up to 32 non-zero bytes at 16 gas each), so intrinsic calldata gas grows by at most 32 * 12 = 384.
 */
export const EXECUTOR_MIN_PAYOUT_CALLDATA_GAS = 384n;

/** Read-only L1 client; L1 chain id from the aztec node must match `readL1RpcUrl` chain id. */
export async function getL1PublicClient(
  readL1RpcUrl: string,
  node: AztecNode,
): Promise<{ publicClient: ViemPublicClient; chainId: bigint }> {
  const info = await node.getNodeInfo();
  const expectedChainId = info.l1ChainId;
  const publicClient = createPublicClient({ l1RpcUrls: [readL1RpcUrl], l1ChainId: expectedChainId });
  const rpcChainId = await publicClient.getChainId();
  if (rpcChainId !== expectedChainId) {
    throw new Error(
      `L1 RPC at ${readL1RpcUrl} reports chain id ${rpcChainId}, but Aztec node reports l1ChainId ${expectedChainId}`,
    );
  }
  return { publicClient, chainId: BigInt(expectedChainId) };
}

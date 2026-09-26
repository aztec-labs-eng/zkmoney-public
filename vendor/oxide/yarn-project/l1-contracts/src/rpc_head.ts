import type { ExtendedViemWalletClient } from '@aztec/ethereum/types';

/** Poll `eth_blockNumber` on `client` (bypassing viem's per-client cache) until it reports a
 *  head ≥ `target`. Bounded by `timeoutMs` so a wedged RPC surfaces as a clear error rather
 *  than hanging indefinitely. Free function with injectable timing so the polling logic is
 *  testable without spinning up a real RPC.
 *
 *  Why it exists: load-balanced RPCs (notably `sepolia.drpc.org`) can mine a tx and return
 *  a receipt from a replica at block N, while the next `eth_call` / `eth_estimateGas` on the
 *  same client hits a different replica still serving block N-1 — so state written by `txHash`
 *  reads as stale and the immediately-following contract call reverts at pre-flight simulation.
 *  Polling for head ≥ receipt.blockNumber gives any caller of a `waitForReceipt: true` write a
 *  read-after-write guarantee at the cost of at most one block of latency.
 */
export async function waitForRpcHead(
  client: Pick<ExtendedViemWalletClient, 'getBlockNumber'>,
  target: bigint,
  {
    timeoutMs = 30_000,
    initialDelayMs = 250,
    maxDelayMs = 2_000,
    now = Date.now,
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  }: {
    timeoutMs?: number;
    initialDelayMs?: number;
    maxDelayMs?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<void> {
  const deadlineMs = now() + timeoutMs;
  let delayMs = initialDelayMs;
  while (true) {
    const head = await client.getBlockNumber({ cacheTime: 0 });
    if (head >= target) {
      return;
    }
    if (now() >= deadlineMs) {
      throw new Error(
        `waitForRpcHead: RPC head ${head} still behind receipt block ${target} after ${timeoutMs}ms — ` +
          `load-balanced replica lag? (consider a single-node RPC for read-after-write flows)`,
      );
    }
    await sleep(delayMs);
    delayMs = Math.min(delayMs * 2, maxDelayMs);
  }
}

import { L1_TRANSACTION_GAS_CAP } from './types.js';

/** Candidates in the order selection considers them: highest tip first. */
export function sortByTipDescending<T>(candidates: readonly T[], tipOf: (candidate: T) => bigint): T[] {
  return [...candidates].sort((a, b) => {
    const ta = tipOf(a);
    const tb = tipOf(b);
    return tb > ta ? 1 : tb < ta ? -1 : 0;
  });
}

export interface BatchQuote {
  totalGas: bigint;
  subsidy: bigint;
}

export type QuoteBatch<T> = (batch: readonly T[]) => Promise<BatchQuote>;

/**
 * If we did not have this limit and just filled the batch until max tx gas limit then we would be blasting the RPC too
 * much when quoting. At a batch of 100 items the tx overhead gas is anyway negligible so trying to optimize that
 * doesn't make sense.
 */
export const MAX_ITEMS_PER_BATCH = 100;

export interface BatchSelectionOpts<T> {
  tipOf: (candidate: T) => bigint;
  /** Signed profit of a quoted batch, in the caller's quote currency. */
  profitOf: (gas: bigint, reward: bigint) => Promise<bigint>;
  /** Profit a batch must clear to be worth a transaction. */
  minProfit: bigint;
  /** Profit a batch must clear as a share of its reward, in basis points. Defaults to no margin requirement. */
  minProfitMarginBps?: bigint;
}

/**
 * Assemble the most profitable batch.
 *
 * Fill to the item cap, then drop the lowest-tip candidate one at a time and stop once the profit stops increasing.
 *
 * Over generic T as it's used for both ProvenWithdrawalJob and PendingProverClaim and these 2 have different shape.
 */
export async function selectProfitableBatch<T>(
  candidates: readonly T[],
  quote: QuoteBatch<T>,
  opts: BatchSelectionOpts<T>,
): Promise<{ batch: T[]; quote: BatchQuote }> {
  const { tipOf, profitOf, minProfit } = opts;
  const minProfitMarginBps = opts.minProfitMarginBps ?? 0n;

  /** Quote a batch and price it. `viable` is "fits one L1 tx and clears both profit floors". */
  const evaluate = async (candidateBatch: readonly T[]) => {
    const quoted = await quote(candidateBatch);
    const reward = candidateBatch.reduce((sum, candidate) => sum + tipOf(candidate), 0n) + quoted.subsidy;
    const profit = await profitOf(quoted.totalGas, reward);
    const viable =
      quoted.totalGas <= L1_TRANSACTION_GAS_CAP &&
      profit >= minProfit &&
      profit * 10_000n >= reward * minProfitMarginBps;
    return { quoted, profit, viable };
  };

  let batch = sortByTipDescending(candidates, tipOf).slice(0, MAX_ITEMS_PER_BATCH);
  let state = await evaluate(batch);

  while (batch.length > 0) {
    const trimmed = batch.slice(0, -1);
    const trimmedState = await evaluate(trimmed);
    // Once viable, stop at the profit maximum. Dropping a candidate only lowers gas, so the batch stays inside
    // the gas cap; it raises profit while lowering reward, so profit/reward rises too and neither floor can be
    // re-crossed. Viability therefore only ever has to be reached, never held.
    if (state.viable && trimmedState.profit <= state.profit) {
      break;
    }
    batch = trimmed;
    state = trimmedState;
  }

  // An empty batch has nothing to submit, so report a zero quote whatever the quote fn returns for it.
  return { batch, quote: batch.length === 0 ? { totalGas: 0n, subsidy: 0n } : state.quoted };
}

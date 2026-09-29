import type { L1TxUtilsConfig } from '@aztec/ethereum/l1-tx-utils';

export const DEFAULT_L1_MIN_PRIORITY_FEE_GWEI = 0.1;

/**
 * On mainnet submission is through a revert-protecting private relay, so a tx that stops being profitable is not
 * included and costs nothing. On Sepolia submission is through the public mempool, and a revert is mined and paid.
 *
 * The chain-dependent half of the config is the expiry window, which `createRelayerSubmission` resolves from the
 * submission endpoint and layers on top of the values below. Callers take the config from there, not from here.
 *
 * No fee bumps. A speed-up resubmits the same calldata under a higher fee ceiling, which breaks the callers that price
 * an on-chain payout floor against the ceiling their tx carries.
 *
 * No cancellation in v1. Protect lets you cancel txs for free but it still takes a few blocks to complete
 * so the throughput gain is minimal to none.
 *
 * `stallTimeMs` cannot trigger a speed-up while `maxSpeedUpAttempts` is 0, but it is not dead config: `getGasPrice`
 * uses it to size the base-fee growth it builds into `maxFeePerGas`. `resolveSubmission` keeps it equal to
 * the expiry window for that reason.
 */
export const RELAYER_V1_L1_TX_UTILS_CONFIG: Partial<L1TxUtilsConfig> = {
  maxSpeedUpAttempts: 0,
  cancelTxOnTimeout: false,
  priorityFeeRetryBumpPercentage: 0,
  gasLimitBufferPercentage: 0,
  minimumPriorityFeePerGas: DEFAULT_L1_MIN_PRIORITY_FEE_GWEI,
};

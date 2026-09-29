/**
 * Builds everything the relayer needs to send an L1 tx: the signing client and the `L1TxUtils` config whose
 * expiry matches the endpoint that client submits to.
 *
 * Flashbots Protect exists to accept transactions while reads are routed through a different RPC. This is done to
 * avoid rate limitting.
 */
import { createExtendedL1Client, makeL1HttpTransport } from '@aztec/ethereum/client';
import type { L1TxUtilsConfig } from '@aztec/ethereum/l1-tx-utils';
import type { ExtendedViemWalletClient } from '@aztec/ethereum/types';

import type { Chain, FallbackTransport, HDAccount, HttpTransport, LocalAccount, PrivateKeyAccount } from 'viem';
import { createWalletClient, publicActions } from 'viem';

import { resolveSubmission } from './l1_submission_rpc.js';
import { DEFAULT_L1_MIN_PRIORITY_FEE_GWEI, RELAYER_V1_L1_TX_UTILS_CONFIG } from './l1_tx_utils_config.js';

/** Protect only accepts submissions: `eth_sendRawTransaction`. */
const SUBMISSION_METHODS = new Set(['eth_sendRawTransaction']);

/** Routes `eth_sendRawTransaction` to `submissionL1RpcUrl` and every other L1 RPC call to `readL1RpcUrl`. */
export function createSplitL1Transport(
  readL1RpcUrl: string,
  submissionL1RpcUrl: string,
): FallbackTransport<HttpTransport[]> {
  const read = makeL1HttpTransport([readL1RpcUrl]);
  const submit = makeL1HttpTransport([submissionL1RpcUrl]);
  const split: FallbackTransport<HttpTransport[]> = params => {
    const readTransport = read(params);
    const submitTransport = submit(params);
    const request: typeof readTransport.request = args =>
      (SUBMISSION_METHODS.has(args.method) ? submitTransport : readTransport).request(args);
    return { ...readTransport, request };
  };
  return split;
}

/** Builds the relayer's signing L1 client, splitting submissions off to `submissionL1RpcUrl` when set. */
export function createRelayerL1Client(
  readL1RpcUrl: string,
  submissionL1RpcUrl: string | undefined,
  account: HDAccount | PrivateKeyAccount | LocalAccount,
  chain: Chain,
): ExtendedViemWalletClient {
  if (!submissionL1RpcUrl) {
    return createExtendedL1Client([readL1RpcUrl], account, chain);
  }
  return createWalletClient({
    account,
    chain,
    transport: createSplitL1Transport(readL1RpcUrl, submissionL1RpcUrl),
  }).extend(publicActions);
}

export interface RelayerSubmissionOptions {
  chainId: number | bigint;
  /**
   * The block window (`--flashbots-block-range`): Protect's drop window on mainnet, and the source of the local
   * expiry on any 12s-slot chain.
   */
  flashbotsBlockRange: number;
  /** The read RPC (`--read-l1-rpc`), which also carries submissions on a chain with no Protect endpoint. */
  readL1RpcUrl: string;
  l1MinPriorityFeeGwei?: number;
  account: HDAccount | PrivateKeyAccount | LocalAccount;
  chain: Chain;
}

export interface RelayerSubmission {
  /** Signs and sends, with reads and submissions already routed to the right endpoint. */
  client: ExtendedViemWalletClient;
  /** The fixed relayer policy with this chain's expiry window layered on; hand it straight to `L1TxUtils`. */
  txUtilsConfig: Partial<L1TxUtilsConfig>;
  /** For the startup log. Unset where submission shares the read RPC, which is to say there is no split. */
  submissionHost?: string;
  /** Protect tx-status endpoint. Unset on chains without Protect. */
  protectTxStatusUrl?: string;
}

/**
 * Resolves the submission route for `chainId` and builds the client and tx config around it. A chain with a
 * Protect endpoint gets the split transport; a chain without one gets a plain client on the read RPC. Both take
 * the route's expiry.
 */
export function createRelayerSubmission(opts: RelayerSubmissionOptions): RelayerSubmission {
  const { protect, txTimeoutMs, stallTimeMs } = resolveSubmission(opts.chainId, opts.flashbotsBlockRange);
  return {
    client: createRelayerL1Client(opts.readL1RpcUrl, protect?.submissionL1RpcUrl, opts.account, opts.chain),
    txUtilsConfig: {
      ...RELAYER_V1_L1_TX_UTILS_CONFIG,
      txTimeoutMs,
      stallTimeMs,
      minimumPriorityFeePerGas: opts.l1MinPriorityFeeGwei ?? DEFAULT_L1_MIN_PRIORITY_FEE_GWEI,
    },
    submissionHost: protect && new URL(protect.submissionL1RpcUrl).hostname,
    protectTxStatusUrl: protect?.protectTxStatusUrl,
  };
}

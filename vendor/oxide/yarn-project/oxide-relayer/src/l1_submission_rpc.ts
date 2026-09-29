/**
 * Resolves the *submission* route only; reads use `--read-l1-rpc`, which `assertNotFlashbots` keeps off the relay,
 * and `createRelayerSubmission` routes the two.
 *
 * Through Protect the relayer treats a locally expired tx as dead and re-submits at the freed nonce, which is only
 * safe against a revert-protecting relay with a bounded, documented drop window. Flashbots is currently the only
 * provider that documents one (`?blockRange=N`, checked 2026-08), hence the fixed URL and the single operator knob
 * (`--flashbots-block-range`) that the local expiry derives from. Fast mode is required: default mode forwards
 * only to the Flashbots builder and burns whole expiry windows waiting for it to win a block.
 *
 * Sepolia has no Protect route: its blocks are built locally (checked 2026-09), so a private submission is not
 * included there. Sepolia submits through its read RPC and takes the block window's duration as its local expiry.
 * Nothing drops a tx on that route and an expiry frees no nonce, so the submission batcher holds until the chain
 * consumes the batch's nonces. A chain with no 12s slots (local anvil) also submits through its read RPC, with
 * static timeouts.
 */
/** Protect's endpoints all sit under this domain, one host per chain. */
const FLASHBOTS_DOMAIN = 'flashbots.net';
/** The Protect submission and tx-status hosts per chain id. A chain that is absent submits through its read RPC. */
const PROTECT_HOSTS = new Map<number, { host: string; statusHost: string }>([
  [1, { host: 'rpc.flashbots.net', statusHost: 'protect.flashbots.net' }],
]);
/** Chains with 12s slots, where one block window converts to one duration: mainnet and Sepolia. */
const TWELVE_SECOND_SLOT_CHAIN_IDS = new Set<number>([1, 11155111]);
const SLOT_MS = 12_000;
/** Relay drop window in blocks; 5 slots of 12s ≈ 1 minute. Overridable via `OXIDE_RELAYER_FLASHBOTS_BLOCK_RANGE`. */
export const DEFAULT_FLASHBOTS_BLOCK_RANGE = 5;
/**
 * Tags submissions as ours (`X-Flashbots-Origin`), the handle Flashbots supports an integrator by. Txs that
 * silently miss the drop window leave no queryable trace, so this is the only starting point for an incident
 * conversation with them.
 */
const SUBMISSION_ORIGIN_ID = 'zk_money_relayer';
/**
 * Local expiry must fire only after the relay's last eligible block, or the relayer frees a nonce a still-live tx
 * can spend. Expiry compares mined-block timestamps (`L1TxUtils.isTxTimedOut`) while the relay caps inclusion at
 * `blockNumber + 1 + blockRange` (`rpc-endpoint`'s `server/request_processor.go`, checked 2026-08), so missed
 * slots separate the two clocks: timestamps advance per slot, block numbers only per block.
 *
 * A margin of `k` slots is therefore exactly the missed-slot budget — `k = 4` is safe unless 4 slots are missed
 * inside the window, or 3 when the relay's block read runs one ahead of ours.
 *
 * Without Protect nothing drops a tx at the window's end. The batcher does not use the window there: it holds until
 * the chain consumes the batch's nonces, and this expiry only frees the caller's work item for a retry.
 */
const EXPIRY_MARGIN_MS = 4 * SLOT_MS;

/** How long the relayer lets an L1 tx live, in the two fields `L1TxUtils` reads it from. */
export interface SubmissionTimeouts {
  /** Local expiry: the block window plus the missed-slot margin on a 12s-slot chain. */
  txTimeoutMs: number;
  /** The priced fee ceiling must survive the whole window the tx is alive for. */
  stallTimeMs: number;
}

/**
 * How this relayer submits on one chain. `protect` is set on a chain with a Protect endpoint; the drop window in its
 * URL and the timeouts are one block range read twice, so they resolve together and never travel apart. Without it,
 * submission shares the read RPC.
 */
export interface SubmissionRoute extends SubmissionTimeouts {
  protect?: {
    /** Receives `eth_sendRawTransaction` and carries the drop window (`?blockRange=N`). */
    submissionL1RpcUrl: string;
    /** Base URL for Protect tx-status reads. */
    protectTxStatusUrl: string;
  };
}

/**
 * Timeouts for a chain with no 12s slots (local anvil), which submits through its read RPC. No relay drops a tx
 * there, so the window is arbitrary and only has to be finite.
 */
export const PUBLIC_MEMPOOL_TIMEOUTS: SubmissionTimeouts = { txTimeoutMs: 30_000, stallTimeMs: 30_000 };

/**
 * Rejects a Flashbots URL configured as the relayer's read RPC. Protect meters reads (200 / IP / 5 min, checked
 * 2026-08) while leaving `eth_sendRawTransaction` unlimited, so reading from it is always a misconfiguration —
 * on every Protect host, not just the mainnet one.
 */
export function assertNotFlashbots(readL1RpcUrl: string): void {
  let url: URL;
  try {
    url = new URL(readL1RpcUrl);
  } catch {
    throw new Error(`the L1 RPC URL must be a valid URL; got '${readL1RpcUrl}'.`);
  }

  if (url.hostname === FLASHBOTS_DOMAIN || url.hostname.endsWith(`.${FLASHBOTS_DOMAIN}`)) {
    throw new Error(
      `Flashbots Protect is not an L1 read RPC: it meters reads and exists to accept submissions. Give ` +
        `--read-l1-rpc (READ_L1_RPC_URL) a normal RPC; submission goes to Protect on its own, on every chain ` +
        `that has an endpoint.`,
    );
  }
}

/** The timeouts one block window converts to on a 12s-slot chain: the window plus the missed-slot margin. */
function windowTimeouts(flashbotsBlockRange: number): SubmissionTimeouts {
  if (!Number.isInteger(flashbotsBlockRange) || flashbotsBlockRange < 1) {
    throw new Error(
      `invalid Flashbots block range '${flashbotsBlockRange}': the drop window must be a positive block count.`,
    );
  }
  const txTimeoutMs = flashbotsBlockRange * SLOT_MS + EXPIRY_MARGIN_MS;
  return { txTimeoutMs, stallTimeMs: txTimeoutMs };
}

/**
 * Resolves the submission route for `chainId`. A chain with a Protect endpoint gets a fast-mode URL carrying
 * `flashbotsBlockRange` as the drop window and the timeouts derived from that same window. A 12s-slot chain without
 * one (Sepolia) gets the same timeouts and no endpoint. Any other chain gets `PUBLIC_MEMPOOL_TIMEOUTS`.
 */
export function resolveSubmission(chainId: number | bigint, flashbotsBlockRange: number): SubmissionRoute {
  const hosts = PROTECT_HOSTS.get(Number(chainId));
  if (hosts === undefined) {
    return TWELVE_SECOND_SLOT_CHAIN_IDS.has(Number(chainId))
      ? windowTimeouts(flashbotsBlockRange)
      : PUBLIC_MEMPOOL_TIMEOUTS;
  }
  const url = new URL(`https://${hosts.host}/fast`);
  url.searchParams.set('blockRange', String(flashbotsBlockRange));
  url.searchParams.set('originId', SUBMISSION_ORIGIN_ID);
  return {
    ...windowTimeouts(flashbotsBlockRange),
    protect: {
      submissionL1RpcUrl: url.toString(),
      protectTxStatusUrl: `https://${hosts.statusHost}/tx/`,
    },
  };
}

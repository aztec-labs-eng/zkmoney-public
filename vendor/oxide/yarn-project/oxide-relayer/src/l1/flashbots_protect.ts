/**
 * The Flashbots Protect endpoints the relayer sends its L1 transactions to, and the guard that keeps Protect out of
 * the read RPC. Reads use `--read-l1-rpc`, which `assertNotFlashbots` keeps off Protect, and viem transports route
 * the two.
 *
 * Through Protect the relayer treats an expired tx as dead and re-submits at the freed nonce, which is only safe
 * against a revert-protecting relay with a bounded, documented drop window. Flashbots is currently the only provider
 * that documents one (`?blockRange=N`, checked 2026-08), hence the fixed URL. Fast mode is required: default mode
 * forwards only to the Flashbots builder and burns whole windows waiting for it to win a block.
 *
 * The block window (`--flashbots-block-range`) is one knob on every chain. The Protect `blockRange` query carries it,
 * and the L1 tx queue uses it for admission and transaction expiry, in blocks. The relay drops a tx after block
 * `blockNumber + 1 + blockRange` (`rpc-endpoint`'s `server/request_processor.go`, checked 2026-08).
 *
 * Only mainnet has a Protect route. Sepolia blocks are built locally (checked 2026-09), so a private submission is
 * not included there. Every other chain, Sepolia and a local anvil included, submits through its read RPC. Nothing
 * drops a tx on that route and an expiry frees no nonce, so the L1 tx queue holds until the chain consumes the
 * batch's nonces. There the transaction monitor's expiry only frees the caller's work item for a retry.
 */
import { mainnet } from 'viem/chains';

/** Protect's endpoints all sit under this domain, one host per chain. */
const FLASHBOTS_DOMAIN = 'flashbots.net';
/** The mainnet Protect RPC in fast mode. */
const PROTECT_RPC_URL = 'https://rpc.flashbots.net/fast';
/** The mainnet Protect tx-status API prefix. */
const PROTECT_TX_STATUS_URL = 'https://protect.flashbots.net/tx/';
/** The block window when the operator sets none: 5 blocks, about 1 minute on mainnet. */
export const DEFAULT_FLASHBOTS_BLOCK_RANGE = 5;
/**
 * Tags submissions as ours (`X-Flashbots-Origin`), the handle Flashbots supports an integrator by. Txs that
 * silently miss the drop window leave no queryable trace, so this is the only starting point for an incident
 * conversation with them.
 */
const SUBMISSION_ORIGIN_ID = 'zk_money_relayer';
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
        `--read-l1-rpc (READ_L1_RPC_URL) a normal RPC; submission goes to Protect on its own on mainnet.`,
    );
  }
}

/** The mainnet Protect URLs. */
export interface ProtectEndpoints {
  /** The fast-mode RPC URL for `eth_sendRawTransaction`. Its `blockRange` query is the drop window. */
  rpcUrl: string;
  /** The tx-status API prefix. Append a transaction hash to get the status of that transaction. */
  txStatusUrl: string;
}

/**
 * The Protect endpoints for `chainId`, with `flashbotsBlockRange` as the drop window. Undefined on a chain other than
 * mainnet, which submits through its read RPC.
 */
export function protectEndpoints(chainId: number, flashbotsBlockRange: number): ProtectEndpoints | undefined {
  if (!Number.isInteger(flashbotsBlockRange) || flashbotsBlockRange < 1) {
    throw new Error(
      `invalid Flashbots block range '${flashbotsBlockRange}': the block window must be a positive block count.`,
    );
  }
  if (chainId !== mainnet.id) {
    return undefined;
  }
  const url = new URL(PROTECT_RPC_URL);
  url.searchParams.set('blockRange', String(flashbotsBlockRange));
  url.searchParams.set('originId', SUBMISSION_ORIGIN_ID);
  return { rpcUrl: url.toString(), txStatusUrl: PROTECT_TX_STATUS_URL };
}

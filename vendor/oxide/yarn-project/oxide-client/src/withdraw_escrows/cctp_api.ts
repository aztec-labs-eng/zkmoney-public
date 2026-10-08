import { CctpBridgeRoute } from '@oxide/l1-contracts/cctp_bridge_on_withdraw.js';

import type { Hex } from 'viem';

import type { CctpBridgeDestination } from './cctp_bridge.js';

/** Circle's CCTP API (Iris) on mainnet. */
export const CCTP_API_URL = 'https://iris-api.circle.com';
// Every bridge escrow burns on Ethereum. Sepolia has the same domain.
const CCTP_ETHEREUM_DOMAIN = 0;

const CCTP_API_TIMEOUT_MS = 10_000;

export type CctpApiOptions = {
  /** Default `CCTP_API_URL`. */
  baseUrl?: string;
};

/** An entry of `GET /v2/burn/USDC/fees`. */
export type CctpFee = {
  finalityThreshold: number;
  /** Basis points of the burn amount. Can be fractional. */
  minimumFee: number;
  /** Forwarding Service fee in USDC units (6 decimals), by gas price tier. Absent where Circle does not forward. */
  forwardFee?: { low: bigint; med: bigint; high: bigint };
};

export async function fetchCctpFees(
  destination: Pick<CctpBridgeDestination, 'domain' | 'route'>,
  options: CctpApiOptions = {},
): Promise<CctpFee[]> {
  const hyperCoreDeposit = destination.route === CctpBridgeRoute.HyperCoreSpot ? '&hyperCoreDeposit=true' : '';
  const response = await cctpGet(
    `/v2/burn/USDC/fees/${CCTP_ETHEREUM_DOMAIN}/${destination.domain}?forward=true${hyperCoreDeposit}`,
    options,
  );
  if (!response.ok) {
    throw new Error(`CCTP fees returned ${response.status}`);
  }
  const body = (await response.json()) as {
    finalityThreshold: number;
    minimumFee: number;
    forwardFee?: { low: number; med: number; high: number };
  }[];
  return body.map(({ finalityThreshold, minimumFee, forwardFee }) => ({
    finalityThreshold,
    minimumFee,
    forwardFee: forwardFee && {
      low: BigInt(forwardFee.low),
      med: BigInt(forwardFee.med),
      high: BigInt(forwardFee.high),
    },
  }));
}

/** The fields of a `GET /v2/messages` entry that track a forwarded burn. */
export type CctpMessage = {
  status: 'pending_confirmations' | 'complete';
  forwardState: 'PENDING' | 'COMPLETE' | 'FAILED' | null;
  /** The destination-chain transaction that minted the USDC. */
  forwardTxHash: Hex | null;
  forwardErrorCode: string | null;
  delayReason: string | null;
};

/** The messages that `txHash` burned, or `undefined` while Circle has not indexed it. */
export async function fetchCctpMessages(txHash: Hex, options: CctpApiOptions = {}): Promise<CctpMessage[] | undefined> {
  const response = await cctpGet(`/v2/messages/${CCTP_ETHEREUM_DOMAIN}?transactionHash=${txHash}`, options);
  if (response.status === 404) {
    return undefined;
  }
  if (!response.ok) {
    throw new Error(`CCTP messages returned ${response.status}`);
  }
  const body = (await response.json()) as { messages: CctpMessage[] };
  return body.messages.map(message => ({
    status: message.status,
    forwardState: message.forwardState ?? null,
    forwardTxHash: message.forwardTxHash ?? null,
    forwardErrorCode: message.forwardErrorCode ?? null,
    delayReason: message.delayReason ?? null,
  }));
}

function cctpGet(path: string, options: CctpApiOptions): Promise<Response> {
  return fetch(`${options.baseUrl ?? CCTP_API_URL}${path}`, { signal: AbortSignal.timeout(CCTP_API_TIMEOUT_MS) });
}

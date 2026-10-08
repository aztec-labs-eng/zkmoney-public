import type { Hex } from 'viem';

import type { AcrossBridgeQuoteArgs } from './across_bridge.js';
import { swappedAtPeg } from './escrow_withdrawal.js';

export const ACROSS_API_URL = 'https://app.across.to/api';
const ACROSS_ORIGIN_CHAIN_ID = 1;

export type AcrossApiOptions = {
  /** Default `ACROSS_API_URL`. */
  baseUrl?: string;
};

/** Amounts are in Across input token units. */
export type AcrossFees = {
  /** 1e18 is 100%. Includes the gas fee. */
  totalRelayFeePct: bigint;
  relayerGasFeePct: bigint;
  relayerGasFee: bigint;
  acrossOutputTokenDecimals: number;
  minDeposit: bigint;
  maxDeposit: bigint;
};

/** Prices the deposit of a 1:1 swap. */
export async function fetchAcrossFees(
  args: AcrossBridgeQuoteArgs,
  options: AcrossApiOptions = {},
): Promise<AcrossFees> {
  const { route } = args;
  const response = await acrossFetch(
    `/suggested-fees?inputToken=${route.acrossInputToken}&outputToken=${route.acrossOutputToken}` +
      `&originChainId=${ACROSS_ORIGIN_CHAIN_ID}&destinationChainId=${route.destinationChainId}` +
      `&amount=${swappedAtPeg(args)}&allowUnmatchedDecimals=true`,
    options,
  );
  const body = (await checkedJson('suggested-fees', response)) as {
    totalRelayFee: { pct: string };
    relayerGasFee: { pct: string; total: string };
    limits: { minDeposit: string; maxDeposit: string };
    outputToken: { decimals: number };
  };
  return {
    totalRelayFeePct: BigInt(body.totalRelayFee.pct),
    relayerGasFeePct: BigInt(body.relayerGasFee.pct),
    relayerGasFee: BigInt(body.relayerGasFee.total),
    acrossOutputTokenDecimals: body.outputToken.decimals,
    minDeposit: BigInt(body.limits.minDeposit),
    maxDeposit: BigInt(body.limits.maxDeposit),
  };
}

export type AcrossDepositStatus =
  | { status: 'pending' | 'slowFillRequested' | 'expired' }
  /** `fillTxHash` is on the destination chain. */
  | { status: 'filled'; fillTxHash: Hex }
  /** `refundTxHash` is on Ethereum. */
  | { status: 'refunded'; refundTxHash: Hex };

/** `undefined` until Across indexes the deposit. */
export async function fetchAcrossDepositStatus(
  txHash: Hex,
  options: AcrossApiOptions = {},
): Promise<AcrossDepositStatus | undefined> {
  const response = await acrossFetch(
    `/deposit/status?originChainId=${ACROSS_ORIGIN_CHAIN_ID}&depositTxHash=${txHash}`,
    options,
  );
  if (response.status === 404) {
    return undefined;
  }
  const body = (await checkedJson('deposit status', response)) as {
    status: AcrossDepositStatus['status'];
    fillTx?: Hex | null;
    depositRefundTxHash?: Hex | null;
  };
  switch (body.status) {
    case 'filled':
      return { status: body.status, fillTxHash: requiredTxHash(body.status, body.fillTx) };
    case 'refunded':
      return { status: body.status, refundTxHash: requiredTxHash(body.status, body.depositRefundTxHash) };
    default:
      return { status: body.status };
  }
}

function requiredTxHash(status: string, txHash: Hex | null | undefined): Hex {
  if (!txHash) {
    throw new Error(`Across deposit status is ${status} but has no transaction hash`);
  }
  return txHash;
}

const ACROSS_API_TIMEOUT_MS = 10_000;

function acrossFetch(path: string, options: AcrossApiOptions): Promise<Response> {
  return fetch(`${options.baseUrl ?? ACROSS_API_URL}${path}`, { signal: AbortSignal.timeout(ACROSS_API_TIMEOUT_MS) });
}

async function checkedJson(name: string, response: Response): Promise<unknown> {
  if (!response.ok) {
    const { message } = (await response.json().catch(() => ({}))) as { message?: string };
    throw new Error(`Across ${name} returned ${response.status}${message ? `: ${message}` : ''}`);
  }
  return await response.json();
}

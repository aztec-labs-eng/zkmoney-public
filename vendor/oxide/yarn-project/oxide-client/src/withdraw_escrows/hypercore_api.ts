import type { EthAddress } from '@aztec/foundation/eth-address';

/** Hyperliquid's API on mainnet. */
export const HYPERLIQUID_API_URL = 'https://api.hyperliquid.xyz';

const HYPERLIQUID_API_TIMEOUT_MS = 10_000;

export type HyperliquidApiOptions = {
  /** Default `HYPERLIQUID_API_URL`. */
  baseUrl?: string;
};

/** Whether `account` exists on HyperCore. The first deposit to a new account pays the activation fee. */
export async function fetchHyperCoreAccountExists(
  account: EthAddress,
  options: HyperliquidApiOptions = {},
): Promise<boolean> {
  const response = await fetch(`${options.baseUrl ?? HYPERLIQUID_API_URL}/info`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'userRole', user: account.toString() }),
    signal: AbortSignal.timeout(HYPERLIQUID_API_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Hyperliquid userRole returned ${response.status}`);
  }
  const { role } = (await response.json()) as { role: string };
  return role !== 'missing';
}

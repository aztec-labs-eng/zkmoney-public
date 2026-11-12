// Mirror of `ThreePoolLib.sol`'s mainnet token constants. Keep in lockstep.
import { EthAddress } from '@aztec-labs/foundation/eth-address';

export const MAINNET_CHAIN_ID = 1n;

export const MAINNET_DAI = EthAddress.fromString('0x6B175474E89094C44Da98b954EedeAC495271d0F');
export const MAINNET_USDC = EthAddress.fromString('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48');
export const MAINNET_USDT = EthAddress.fromString('0xdAC17F958D2ee523a2206206994597C13D831ec7');

export const MAINNET_DEPOSIT_TOKENS = [MAINNET_DAI, MAINNET_USDC, MAINNET_USDT];

/** The largest loss a 3pool swap accepts, in basis points. Mirrors `ThreePoolLib.sol`. */
export const THREE_POOL_SWAP_MAX_SLIPPAGE_BPS = 100n;

/** Tokens a SIPA may be funded with: mainnet accepts the SIPA's swap inputs, other chains only the Portal underlying. */
export function depositTokensFor(chainId: bigint, portalToken: EthAddress): EthAddress[] {
  return chainId === MAINNET_CHAIN_ID ? MAINNET_DEPOSIT_TOKENS : [portalToken];
}

/**
 * The tokens whose sweeps pay out in one of `payoutTokens`, so a relayer that accepts these payout tokens watches
 * them. This is the inverse of `depositPayoutTokenFor`: on mainnet, USDC and USDT are on the list only when DAI is a
 * payout token, and every other token only when it is a payout token itself.
 */
export function sweepTokensFor(chainId: bigint, payoutTokens: readonly EthAddress[]): EthAddress[] {
  const candidates = chainId === MAINNET_CHAIN_ID ? [...payoutTokens, ...MAINNET_DEPOSIT_TOKENS] : [...payoutTokens];
  const paysOut = (token: EthAddress) =>
    payoutTokens.some(payoutToken => payoutToken.equals(depositPayoutTokenFor(chainId, token)));
  return unique(candidates.filter(paysOut));
}

/**
 * The token a sweep of `sentToken` pays its fee and its subsidy in, and so the payout token of the L1 operation
 * that sweeps it. Every SIPA swaps: on mainnet it swaps USDC and USDT to DAI before it routes the funds. Every other
 * sweep pays in the sent token. The deposit subsidy pays in the same token.
 */
export function depositPayoutTokenFor(chainId: bigint, sentToken: EthAddress): EthAddress {
  const swapped = chainId === MAINNET_CHAIN_ID && (sentToken.equals(MAINNET_USDC) || sentToken.equals(MAINNET_USDT));
  return swapped ? MAINNET_DAI : sentToken;
}

function unique(tokens: EthAddress[]): EthAddress[] {
  return tokens.filter((token, index) => tokens.findIndex(other => other.equals(token)) === index);
}

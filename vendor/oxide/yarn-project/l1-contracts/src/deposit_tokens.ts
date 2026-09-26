// Mirror of `ThreePoolLib.sol`'s mainnet token constants. Keep in lockstep.
import { EthAddress } from '@aztec/foundation/eth-address';

export const MAINNET_CHAIN_ID = 1n;

export const MAINNET_DAI = EthAddress.fromString('0x6B175474E89094C44Da98b954EedeAC495271d0F');
export const MAINNET_USDC = EthAddress.fromString('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48');
export const MAINNET_USDT = EthAddress.fromString('0xdAC17F958D2ee523a2206206994597C13D831ec7');

export const MAINNET_DEPOSIT_TOKENS = [MAINNET_DAI, MAINNET_USDC, MAINNET_USDT];

/** Tokens a SIPA may be funded with: mainnet accepts the SIPA's swap inputs, other chains only the Portal underlying. */
export function depositTokensFor(chainId: bigint, portalToken: EthAddress): EthAddress[] {
  return chainId === MAINNET_CHAIN_ID ? MAINNET_DEPOSIT_TOKENS : [portalToken];
}

/**
 * The token a sweep of `sentToken` pays its fee and its subsidy in, and so the payout token of the L1 operation
 * that sweeps it. Mirrors `Pool.relayedDeposit`: the sent token where the Pool has a portal for it, DAI where the
 * Pool swaps it first (mainnet USDC and USDT). The deposit subsidy pays in the same token.
 */
export function depositPayoutTokenFor(chainId: bigint, sentToken: EthAddress): EthAddress {
  return chainId === MAINNET_CHAIN_ID && !sentToken.equals(MAINNET_DAI) ? MAINNET_DAI : sentToken;
}

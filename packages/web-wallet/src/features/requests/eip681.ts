/**
 * EIP-681 ERC-20 transfer URIs (`ethereum:<token>@<chainId>/transfer?...`) —
 * what the accountless pay QR encodes. Wallets open pre-filled; there is NO
 * callback to this page — the chain is the only feedback channel.
 * Takes raw atomic amounts.
 */
import type { Address } from "viem"

export function buildErc20TransferUri(opts: {
  token: Address
  chainId: number
  to: Address
  rawAmount: bigint
}): string {
  return `ethereum:${opts.token}@${opts.chainId}/transfer?address=${opts.to}&uint256=${opts.rawAmount}`
}

/** Without `uint256` — the amount is entered in the sending wallet. */
export function buildErc20TransferUriWithoutAmount(opts: {
  token: Address
  chainId: number
  to: Address
}): string {
  return `ethereum:${opts.token}@${opts.chainId}/transfer?address=${opts.to}`
}

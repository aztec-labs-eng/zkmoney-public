import { getAddress } from "viem"
import type { Address } from "viem"

const same = (a?: string | null, b?: string | null) =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase()

/** The connected account as the recipient, under its saved name before the wallet's own. */
export const connectedRecipient = (
  account: string,
  saved: readonly { address: string; name?: string }[],
  walletName: string | null | undefined,
): { recipient: Address; name?: string } => ({
  recipient: getAddress(account),
  name: saved.find((w) => same(w.address, account))?.name ?? walletName ?? undefined,
})

/**
 * The name on a recipient's wallet pill: the recipient's own name (typed, saved or ENS), else the
 * connected wallet's, else the fallback. A typed address that is neither saved nor connected, and
 * the ether.fi Cash contact, get no pill.
 */
export function walletPillName(
  recipient: string | null,
  wallet: {
    saved: boolean
    savedName: string | undefined
    connected: string | null | undefined
    walletName: string | null | undefined
    etherfi: boolean
    fallback: string
  },
): string | undefined {
  if (!recipient || wallet.etherfi) return undefined
  const connected = same(recipient, wallet.connected)
  if (!wallet.saved && !connected) return undefined
  return wallet.savedName ?? (connected ? wallet.walletName : undefined) ?? wallet.fallback
}

/** Whether the address step asks a name: for a parsed address no saved wallet answers to. */
export const asksName = (search: string, target: string | null, saved: boolean) =>
  !!search && !!target && !saved

/** The address step's name for its recipient: the typed one where asked, else saved, else ENS. */
export const addressName = (
  asked: boolean,
  typedName: string,
  savedName: string | undefined,
  ensName: string | undefined,
): string | undefined => (asked && typedName.trim()) || savedName || ensName || undefined

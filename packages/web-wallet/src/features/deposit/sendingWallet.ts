import { upsertDepositL1WalletContact, type Contacts } from "@obsidion/front-core"

/** The saved wallets a deposit's sending wallet joins; none for a visitor. */
export type SavedWallets = Pick<Contacts, "upsertL1WalletContact">

/**
 * Saves the wallet that sent a deposit, once its transfer is broadcast. A payer's wallet is not the
 * user's, so the sheets never save it.
 */
export function saveSendingWallet(
  contacts: SavedWallets | null | undefined,
  wallet: { address: string; walletName?: string },
  now: () => number,
): void {
  if (!contacts) return
  void upsertDepositL1WalletContact(contacts, { ...wallet, lastUsedAt: now() })
}

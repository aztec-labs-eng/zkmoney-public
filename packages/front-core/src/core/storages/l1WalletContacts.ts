import { isAddress, type Address } from "viem"

import { logger } from "src/utils/logger"
import { isZeroAddress } from "src/utils/validate"

import { ContactStorage, L1_PLACEHOLDER_NAME, isUserLabel, type Contact } from "./ContactStorage.js"

const UNKNOWN_PROVIDER = "unknown"

export interface UpsertDepositL1WalletContactParams {
  address: string
  walletId?: string | null
  walletName?: string | null
  walletImageUrl?: string | null
  walletProvider?: string | null
  lastUsedAt?: number
}

/**
 * Persist the on-chain funder as a deposit-attested L1 contact. A token mint reports the zero
 * address — skip it, it is not a wallet.
 */
export async function upsertDepositL1WalletContact({
  address,
  walletId,
  walletName,
  walletImageUrl,
  walletProvider,
  lastUsedAt,
}: UpsertDepositL1WalletContactParams): Promise<void> {
  if (!isAddress(address) || isZeroAddress(address)) return

  const provider = walletProvider?.trim() || UNKNOWN_PROVIDER
  const displayName = walletName?.trim() || L1_PLACEHOLDER_NAME
  const imageUrl = walletImageUrl ?? undefined

  try {
    await ContactStorage.get().upsertL1WalletContact({
      name: displayName,
      address: address as Address,
      provider,
      walletId: walletId ?? undefined,
      walletName: displayName,
      imageUrl,
      provenance: "deposit-attested",
      avatar: imageUrl ? { type: "image", url: imageUrl } : undefined,
      lastUsedAt,
    })
  } catch (err) {
    logger.warn("[L1WalletContacts] Failed to upsert deposit contact:", err)
  }
}

export interface UpsertSavedL1WalletContactParams {
  address: string
  name?: string | null
  lastUsedAt?: number
}

/** Persist a withdrawal recipient so it reappears as an L1 contact. */
export async function upsertSavedL1WalletContact({
  address,
  name,
  lastUsedAt,
}: UpsertSavedL1WalletContactParams): Promise<void> {
  if (!isAddress(address) || isZeroAddress(address)) return

  const labeled = isUserLabel(name)
  const displayName = labeled ? name!.trim() : L1_PLACEHOLDER_NAME

  try {
    await ContactStorage.get().upsertL1WalletContact({
      name: displayName,
      address: address as Address,
      provider: "manual",
      walletName: displayName,
      provenance: "saved-recipient",
      userLabeled: labeled || undefined,
      lastUsedAt: lastUsedAt ?? Date.now(),
    })
  } catch (err) {
    logger.warn("[L1WalletContacts] Failed to upsert saved recipient:", err)
  }
}

export interface UpdateSavedL1WalletContactParams {
  /** Identity of the row being edited. */
  originalAddress: string
  provider: string
  /** New values. An empty/placeholder name clears back to "External Wallet". */
  address: string
  name?: string | null
}

/**
 * User edit of an L1 wallet row (label and/or address). ContactStorage records
 * replaced addresses so the old address stops surfacing under "Recent", and
 * creates a saved-recipient row when the edited row was deposit-history-only.
 * Unlike the upsert helpers this THROWS on failure (invalid address, address
 * collision) so the caller can surface the error.
 */
export async function updateSavedL1WalletContact({
  originalAddress,
  provider,
  address,
  name,
}: UpdateSavedL1WalletContactParams): Promise<Contact> {
  if (!isAddress(address) || isZeroAddress(address)) {
    throw new Error("Invalid address")
  }
  return ContactStorage.get().updateL1WalletContact({
    originalAddress,
    provider,
    address,
    name: name ?? "",
  })
}

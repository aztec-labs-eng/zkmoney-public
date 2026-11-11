import { isAddress, type Address } from "viem"

import { isZeroAddress } from "../utils/validate"

import { L1_PLACEHOLDER_NAME, isUserLabel, type Contact, type Contacts } from "./contacts"
import type { EnsNames } from "../core/services/ens"
import { bestEffort, WalletError } from "./errors"
import { task, type Task } from "./runtime"

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
export async function upsertDepositL1WalletContact(
  contacts: Pick<Contacts, "upsertL1WalletContact">,
  {
    address,
    walletId,
    walletName,
    walletImageUrl,
    walletProvider,
    lastUsedAt,
  }: UpsertDepositL1WalletContactParams,
): Promise<void> {
  if (!isAddress(address) || isZeroAddress(address)) return

  const provider = walletProvider?.trim() || UNKNOWN_PROVIDER
  const displayName = walletName?.trim() || L1_PLACEHOLDER_NAME
  const imageUrl = walletImageUrl ?? undefined

  await bestEffort(
    "unknown",
    contacts.upsertL1WalletContact({
      name: displayName,
      address: address as Address,
      provider,
      walletId: walletId ?? undefined,
      walletName: displayName,
      imageUrl,
      provenance: "deposit-attested",
      avatar: imageUrl ? { type: "image", url: imageUrl } : undefined,
      lastUsedAt,
    }),
  )
}

export interface UpsertSavedL1WalletContactParams {
  address: string
  name?: string | null
  /** A real slug keeps the row apart from user-typed recipients; defaults to `"manual"`. */
  provider?: string
  lastUsedAt?: number
}

/** Persist a withdrawal recipient so it reappears as an L1 contact. */
export async function upsertSavedL1WalletContact(
  contacts: Pick<Contacts, "upsertL1WalletContact">,
  { address, name, provider = "manual", lastUsedAt }: UpsertSavedL1WalletContactParams,
): Promise<void> {
  if (!isAddress(address) || isZeroAddress(address)) return

  const labeled = isUserLabel(name)
  const displayName = labeled ? name!.trim() : L1_PLACEHOLDER_NAME

  await bestEffort(
    "unknown",
    contacts.upsertL1WalletContact({
      name: displayName,
      address: address as Address,
      provider,
      walletName: displayName,
      provenance: "saved-recipient",
      userLabeled: labeled || undefined,
      lastUsedAt,
    }),
  )
}

const unnamedL1 = (entry: Contact): boolean =>
  !!entry.l1Wallet && !entry.l1Wallet.deletedAt && !isUserLabel(entry.name)

/**
 * Names each unlabeled L1 contact (stored as the placeholder, so shown by its address) after its
 * ENS primary name, on each change of the book. A label the user typed is never replaced. A failed
 * write runs again after 1 s, doubling to a minute.
 */
export function ensContactNames(
  contacts: Pick<Contacts, "view" | "nameUnlabeledL1Contact">,
  names: EnsNames,
): Task {
  return task("ensContactNames", {
    needs: {},
    on: { book: contacts.view },
    every: "once",
    backoff: { baseMs: 1_000, maxMs: 60_000 },
    run: async ({ book: { records, loaded } }) => {
      if (!loaded) return
      await Promise.all(
        records.filter(unnamedL1).map(async ({ address, l1Wallet }) => {
          const name = await bestEffort("unknown", names(address as Address).read())
          if (!name) return
          await contacts.nameUnlabeledL1Contact({ address, provider: l1Wallet!.provider }, name)
        }),
      )
    },
  })
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
 * User edit of an L1 wallet row (label and/or address). The book records replaced addresses so
 * the old address stops surfacing under "Recent", and creates a saved-recipient row when the
 * edited row was deposit-history-only. Unlike the upsert helpers this throws on failure (invalid
 * address, address collision) so the caller can surface the error.
 */
export async function updateSavedL1WalletContact(
  contacts: Pick<Contacts, "updateL1WalletContact">,
  { originalAddress, provider, address, name }: UpdateSavedL1WalletContactParams,
): Promise<Contact> {
  if (!isAddress(address) || isZeroAddress(address)) {
    throw new WalletError("unknown", "Invalid address")
  }
  return contacts.updateL1WalletContact({ originalAddress, provider, address, name: name ?? "" })
}

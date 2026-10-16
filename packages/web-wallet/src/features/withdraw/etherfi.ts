import { useEffect, useState } from "react"
import {
  ContactStorage,
  updateSavedL1WalletContact,
  upsertSavedL1WalletContact,
  type Contact,
} from "@obsidion/front-core"
import type { Address } from "viem"
import { getConfig } from "../../config/env"
import { networkHasSwapStack, SWAP_ROUTE_SHOWCASE } from "./freshAddressAvailability"
import { useOxideTuple } from "./useOxideTuple"
import type { WithdrawalReceiveAsset } from "./withdrawAssets"

/** Where ether.fi Cash shows the user the address its balance is funded at. */
export const ETHERFI_SHARE_ADDRESS_URL = "https://www.ether.fi/app/cash/add/crypto/share-address"

/** Provider slug of the saved ether.fi Cash address; a real slug, so it never collapses into a manual row. */
export const ETHERFI_PROVIDER = "etherfi"
export const ETHERFI_CONTACT_NAME = "ether.fi Cash"

/** What ether.fi Cash credits: USDC and USDT on Ethereum. DAI and ETH sent there are not credited. */
export const ETHERFI_RECEIVE_ASSETS: readonly WithdrawalReceiveAsset[] = ["USDC", "USDT"]
export const ETHERFI_DEFAULT_ASSET: WithdrawalReceiveAsset = "USDC"
export const ETHERFI_ASSETS_COPY = "USDC or USDT on Ethereum only"

export const isEtherfiContact = (entry: Contact) =>
  entry.addressKind === "ethereum-l1" && entry.l1Wallet?.provider === ETHERFI_PROVIDER

/**
 * Keeps the address as the ether.fi Cash contact, so the next withdrawal starts from it. One
 * replacing a saved address rewrites that row, so the old address does not come back as the
 * default; a rewrite the store refuses (the address already names another row) saves afresh.
 */
export async function saveEtherfiAddress(address: Address, previous?: Address): Promise<void> {
  if (previous && previous.toLowerCase() !== address.toLowerCase()) {
    try {
      await updateSavedL1WalletContact({
        originalAddress: previous,
        provider: ETHERFI_PROVIDER,
        address,
        name: ETHERFI_CONTACT_NAME,
      })
      return
    } catch {
      // fall through to a fresh save
    }
  }
  await upsertSavedL1WalletContact({
    address,
    name: ETHERFI_CONTACT_NAME,
    provider: ETHERFI_PROVIDER,
  })
}

/**
 * Whether the ether.fi route can be offered: both of its outputs ride a swap escrow, so the network
 * must carry a swap stack and the manifest must name the factory and the executor that prices it.
 * `undefined` until the manifest answers; one that cannot be read fails closed.
 */
export function useEtherfiAvailable(): boolean | undefined {
  const swapStack = networkHasSwapStack(getConfig().network)
  const tuple = useOxideTuple(!SWAP_ROUTE_SHOWCASE && swapStack)
  if (SWAP_ROUTE_SHOWCASE) return true
  if (!swapStack) return false
  if (tuple === undefined) return undefined
  return !!tuple?.swapEscrowFactoryV2?.trim() && !!tuple?.operationExecutor?.trim()
}

/** The most recently used saved ether.fi Cash address, `null` when none is kept; `undefined` while reading. */
export function useSavedEtherfiAddress(): Address | null | undefined {
  const [address, setAddress] = useState<Address | null>()
  useEffect(() => {
    const store = ContactStorage.get()
    const read = () =>
      store
        .getEntries()
        .then((entries) => {
          // A removed row is a tombstone that a later save revives.
          const [row] = entries
            .filter((e) => {
              const w = e.l1Wallet
              return (
                isEtherfiContact(e) && !!w && (!w.deletedAt || (w.lastUsedAt ?? 0) > w.deletedAt)
              )
            })
            .sort((a, b) => (b.l1Wallet!.lastUsedAt ?? 0) - (a.l1Wallet!.lastUsedAt ?? 0))
          setAddress(row ? (row.address as Address) : null)
        })
        .catch(() => setAddress(null))
    void read()
    return store.onChange(read)
  }, [])
  return address
}

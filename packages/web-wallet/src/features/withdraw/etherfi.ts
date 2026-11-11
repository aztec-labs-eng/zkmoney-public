import { bestEffort } from "@obsidion/core/errors"
import {
  updateSavedL1WalletContact,
  upsertSavedL1WalletContact,
  useStore,
} from "@obsidion/front-core"
import type { Contact, Contacts, RecordSet } from "@obsidion/front-core"
import type { Address } from "viem"
import { contactBook } from "../../session/contacts"
import { ETHERFI_PROVIDER, isEtherfiContact } from "../../session/savedL1Wallets"
import { useSession } from "../../session/session"
import { networkHasSwapStack, SWAP_ROUTE_SHOWCASE } from "./freshAddressAvailability"
import { useOxideTuple } from "./useOxideTuple"
import type { BridgeOutChain } from "./bridgeOutQuote"
import type { WithdrawalReceiveAsset } from "./withdrawAssets"

/** Where ether.fi Cash shows the user the address its balance is funded at. */
export const ETHERFI_SHARE_ADDRESS_URL = "https://www.ether.fi/app/cash/add/crypto/share-address"

export const ETHERFI_CONTACT_NAME = "ether.fi Cash"

/** What ether.fi Cash credits: USDC and USDT. DAI and ETH sent there are not credited. */
export const ETHERFI_RECEIVE_ASSETS: readonly WithdrawalReceiveAsset[] = ["USDC", "USDT"]

/**
 * The chains where a Cash account's own address takes USDC and USDT, by id: OP Mainnet, where the
 * account lives, and the top-up chains Ethereum, Arbitrum, Base and HyperEVM, which bridge to it.
 * ether.fi's other networks deposit through a provider address of their own, never this one.
 */
export const ETHERFI_TOP_UP_CHAINS: ReadonlySet<number> = new Set([1, 10, 42161, 8453, 999])

/** The bridge-out routes an ether.fi Cash address can take: those on its top-up chains. */
export const etherfiRoutes = (routes: readonly BridgeOutChain[]): BridgeOutChain[] =>
  routes.filter((route) => ETHERFI_TOP_UP_CHAINS.has(route.chain.chainId))

/**
 * Keeps the address as the ether.fi Cash contact, so the next withdrawal starts from it. One
 * replacing a saved address rewrites that row, so the old address does not come back as the
 * default; a rewrite the store refuses (the address already names another row) saves afresh.
 */
export async function saveEtherfiAddress(
  contacts: Pick<Contacts, "updateL1WalletContact" | "upsertL1WalletContact">,
  address: Address,
  previous?: Address,
): Promise<void> {
  if (previous && previous.toLowerCase() !== address.toLowerCase()) {
    const rewritten = await bestEffort(
      "unknown",
      updateSavedL1WalletContact(contacts, {
        originalAddress: previous,
        provider: ETHERFI_PROVIDER,
        address,
        name: ETHERFI_CONTACT_NAME,
      }).then(() => true),
    )
    if (rewritten) return
  }
  await upsertSavedL1WalletContact(contacts, {
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
export function useEtherfiAvailable(enabled = true): boolean | undefined {
  const swapStack = networkHasSwapStack(useSession().page.config.network)
  const tuple = useOxideTuple(enabled && !SWAP_ROUTE_SHOWCASE && swapStack)
  if (!enabled) return false
  if (SWAP_ROUTE_SHOWCASE) return true
  if (!swapStack) return false
  if (tuple === undefined) return undefined
  return !!tuple?.swapEscrowFactoryV2?.trim() && !!tuple?.operationExecutor?.trim()
}

/** The most recently used live ether.fi Cash address of `book`; undefined while it reads. */
export function savedEtherfiAddress({
  records,
  loaded,
  failed,
}: RecordSet<Contact>): Address | null | undefined {
  if (failed) return null
  if (!loaded) return undefined
  // A removed row is a tombstone that a later save revives.
  const [row] = records
    .filter((e) => {
      const w = e.l1Wallet
      return isEtherfiContact(e) && !!w && (!w.deletedAt || (w.lastUsedAt ?? 0) > w.deletedAt)
    })
    .sort((a, b) => (b.l1Wallet!.lastUsedAt ?? 0) - (a.l1Wallet!.lastUsedAt ?? 0))
  return row ? (row.address as Address) : null
}

/** The most recently used saved ether.fi Cash address, `null` when none is kept; `undefined` while reading. */
export function useSavedEtherfiAddress(): Address | null | undefined {
  return useStore(contactBook(useSession()), savedEtherfiAddress)
}

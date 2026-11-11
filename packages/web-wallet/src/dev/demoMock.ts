/**
 * A dev `/dev/mock/<area>/<name>` page: the Page's fake reads, the records it seeds through the real
 * Stores, and where its screen opens. Demo mode only: its fakes keep the rest off the network.
 */
import type { Address } from "viem"
import type { Pace } from "@obsidion/core/cadence"
import { bestEffort } from "@obsidion/core/errors"
import type { BridgeInProvider } from "@obsidion/front-core"
import type { WebWalletConfig } from "../config/env"
import type { PageScreens } from "../app/sessionDeps"
import type { PageLoaders } from "../app/pageChain"
import type { Session } from "../session/session"
import type { SavedL1Wallet } from "../session/savedL1Wallets"
import { profileBridge } from "../session/walletChains"

export interface DemoMock {
  loaders: Partial<PageLoaders>
  /** The bridge in place of the demo's. */
  bridgeInProvider?: BridgeInProvider
  /** The fake wallet starts connected. */
  connected: boolean
  /** The private balance, atomic DAI, in place of the scenario's. */
  balance?: bigint
  /** Writes the mock's records and starts its journey; resolves to where its screen opens. */
  seed(session: Session): Promise<PageScreens>
}

/** A saved recipient's L1 wallet contact. */
export const savedWallet = (
  name: string,
  address: Address,
  provider = "manual",
): SavedL1Wallet => ({
  name,
  address,
  entry: {
    name,
    address,
    addressKind: "ethereum-l1",
    l1Wallet: { provider, provenance: "saved-recipient" },
  },
})

/** Writes `wallets` as the session's saved L1 wallets. */
export async function seedSavedWallets(session: Session, wallets: SavedL1Wallet[]): Promise<void> {
  for (const { name, address, entry } of wallets)
    await session.contacts?.upsertL1WalletContact({
      name: name ?? entry.name,
      address,
      provider: entry.l1Wallet!.provider,
      walletName: name,
      provenance: entry.l1Wallet!.provenance,
    })
}

/** Runs each step `at` ms from now on the page's pace. */
export function playJourney(pace: Pace, steps: { at: number; run: () => Promise<unknown> }[]) {
  for (const { at, run } of steps) pace.after(at, () => void bestEffort("unknown", run()))
}

/** `ethereum`, `l1` or the L1's id; a bridge chain's name or id. */
export function chainFor(
  network: string | null,
  bridged: boolean,
  config: Pick<WebWalletConfig, "l1ChainId" | "bridge">,
): number {
  const l1 = config.l1ChainId
  const chains = profileBridge(config)?.chains ?? []
  const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "")
  if (network) {
    if (["ethereum", "l1", "mainnet", String(l1)].includes(slug(network))) return l1
    const match = chains.find(
      (c) => String(c.chainId) === network || slug(c.name).startsWith(slug(network)),
    )
    if (match) return match.chainId
  }
  return bridged ? chains[0]?.chainId ?? l1 : l1
}

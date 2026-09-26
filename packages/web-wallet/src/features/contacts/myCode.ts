import { isDemoMode } from "../../dev/demoFlag"
import type { Address } from "viem"
import type { Network } from "@obsidion/core/constants"
import {
  deriveBootstrapKey,
  mintQRHandshakeShare,
  mintableOrigin,
  type FieldLike,
} from "@obsidion/front-core"

/** Web deps for one my-code mint. The XMTP handle is the bootstrap EOA, the address the wallet
 *  links to its inbox and the oxide account publishes, so both platforms mint the same
 *  connect-back target for the same account. */
export interface MintMyCodeDeps {
  /** Own tag from wallet identity; absent mints the tag-less (non-discoverable) link. */
  ownTag: string | undefined
  /** In-memory master secret (aztec Fr, structural). */
  masterSecret: FieldLike
  /** Packet-version chain segment, and the network the fallback wallet origin is picked for. */
  chain: Network
  /** Own L2 address for direct display / payment. */
  l2Address?: string
  /** Persist the per-share uuid (IssuedConnectStorage.recordHandshake). */
  record: (uuid: string) => Promise<void>
  uuid?: () => string
  now?: () => number
  /** This deploy's origin; defaults to the browser's. */
  origin?: string
}

/** Mint one fresh `<this deploy>/connect#<packet>` link. The web wallet is the only surface that
 *  handles `/connect`, and a staging or PR-preview build has to hand out links back to itself, so
 *  the mint rides this deploy's own origin. The core encodes before recording, so a failed encode
 *  leaves no local record. */

export async function mintMyConnectLink(deps: MintMyCodeDeps): Promise<string> {
  if (import.meta.env.DEV && isDemoMode()) {
    deps = await (await import("../../dev/contactDemo")).prepareDemoConnectMint(deps)
  }
  const ownXmtpHandle: Address = deriveBootstrapKey(deps.masterSecret).address
  return mintQRHandshakeShare({
    tag: deps.ownTag || undefined,
    ownXmtpHandle,
    chain: deps.chain,
    baseUrl: mintableOrigin(deps.origin ?? window.location.origin, deps.chain),
    l2Address: deps.l2Address,
    uuid: deps.uuid ?? (() => crypto.randomUUID()),
    now: deps.now ?? Date.now,
    record: deps.record,
  })
}

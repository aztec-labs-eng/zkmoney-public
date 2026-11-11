import {
  mintableOrigin,
  mintRequestLink,
  sipaDeploymentTag,
  sipaLinkPreimage,
  type MintedRequestLink,
  type MintRequestLinkArgs,
  type StoredRequest,
  type SipaOrigin,
} from "@obsidion/front-core"
import type { Network } from "@obsidion/sdk"

/** Request links land on this deploy's pay page, unless a scanner would refuse its origin. */
export function requestLinkOrigin(network: Network): string {
  return mintableOrigin(location.origin, network)
}

export interface RequestLinkStore {
  add(row: StoredRequest): Promise<void>
}

/**
 * Persist the fulfilled-signal join row before exposing the shareable URL. A link with an address
 * carries its preimage, and a code its deployment tag, so a payer can check it against the active
 * deployment.
 */
export async function createAndStoreRequestLink(
  input: MintRequestLinkArgs,
  store: RequestLinkStore,
  /** What this wallet recorded when it derived `sipa`. */
  originOf: (sipa: string) => Promise<SipaOrigin | undefined>,
): Promise<MintedRequestLink> {
  const origin = input.sipaAddress ? await originOf(input.sipaAddress) : undefined
  const minted = mintRequestLink({
    ...input,
    sipaPreimage: input.sipaPreimage ?? (origin && sipaLinkPreimage(origin)),
    sipaDeployment: input.sipaDeployment ?? (origin && sipaDeploymentTag(origin)),
  })
  await store.add(minted.row)
  return minted
}

import type { Address } from "viem"
import {
  mintableOrigin,
  mintRequestLink,
  sipaLinkPreimage,
  SIPADepositStore,
  type MintedRequestLink,
  type MintRequestLinkArgs,
  type PaymentRequest,
  type SipaLinkPreimage,
} from "@obsidion/front-core"
import { getConfig } from "../../config/env"
import { webStorage } from "../../platform/storage/WebStorageAdapter"

/** Request links land on this deploy's pay page, unless a scanner would refuse its origin. */
export function requestLinkOrigin(): string {
  return mintableOrigin(location.origin, getConfig().network)
}

export interface RequestLinkStore {
  add(row: PaymentRequest): Promise<void>
}

/** The preimage this wallet recorded when it derived `sipa`. */
async function recordedSipaPreimage(sipa: string): Promise<SipaLinkPreimage | undefined> {
  const deposits = SIPADepositStore.get(webStorage)
  await deposits.load()
  const origin = deposits.get(sipa as Address)?.origin
  return origin && sipaLinkPreimage(origin)
}

/**
 * Persist the fulfilled-signal join row before exposing the shareable URL. A link with an address
 * carries its preimage, so a payer can check it against the active deployment.
 */
export async function createAndStoreRequestLink(
  input: MintRequestLinkArgs,
  store: RequestLinkStore,
  preimageOf: (sipa: string) => Promise<SipaLinkPreimage | undefined> = recordedSipaPreimage,
): Promise<MintedRequestLink> {
  const sipaPreimage =
    input.sipaPreimage ?? (input.sipaAddress ? await preimageOf(input.sipaAddress) : undefined)
  const minted = mintRequestLink({ ...input, sipaPreimage })
  await store.add(minted.row)
  return minted
}

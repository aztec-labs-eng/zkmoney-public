import {
  mintRequestLink,
  type MintedRequestLink,
  type MintRequestLinkArgs,
  type PaymentRequest,
} from "@obsidion/front-core"

export interface RequestLinkStore {
  add(row: PaymentRequest): Promise<void>
}

/** Persist the fulfilled-signal join row before exposing the shareable URL. */
export async function createAndStoreRequestLink(
  input: MintRequestLinkArgs,
  store: RequestLinkStore,
): Promise<MintedRequestLink> {
  const minted = mintRequestLink(input)
  await store.add(minted.row)
  return minted
}

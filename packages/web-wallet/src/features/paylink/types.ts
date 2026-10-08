/** `claimed`: the nullifier is spent, by a claim or the sender's refund. `expired`: unspent past `claimableUntil` by chain time (`withExpiry`). */
export type LinkStatus = "unclaimed" | "claimed" | "expired"

export type CreateStage = "building" | "proving" | "submitting"

export type LinkFlavor = "direct" | "email"

export interface PaymentLink {
  url: string
  /** The self-contained reconstruction payload (base64url CBOR, rides the URL fragment). */
  fragment: string
  /**
   * Display amount in the wallet token, read from the escrow note: absent until that lands and once
   * the note is spent. The link's own figure is unsigned text and never shown. A creator's copy carries
   * the amount it was made with.
   */
  amount?: string
  /** Source token read from the escrow note. */
  tokenAddress?: string
  status: LinkStatus
  flavor: LinkFlavor
  /** Email the claim is locked to (email flavor only), off the funding transfer's created lane. */
  email?: string
  /** The claim commitment the escrow note binds (email flavor only), hex. */
  commitment?: string
  /** Unix seconds the claim window opens (`from_claimable`). From the escrow note or this device's create row. */
  claimableFrom?: number
  /** Unix seconds the claim window closes (`until_claimable`), from the escrow note. */
  claimableUntil?: number
  /** L2 tx that funded the escrow. Known once the create lands; a link minted before that carries none. */
  txHash?: string
  /** Creator's memo, off the escrow's funding transfer, or set on create. */
  memo?: string
}

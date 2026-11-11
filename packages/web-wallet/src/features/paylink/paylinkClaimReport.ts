import { bestEffort, type OwedClaims, type WithdrawalRecord } from "@obsidion/front-core"
import {
  analyticsEnabled,
  firePaylinkEvent,
  paylinkAmountBucket,
  paylinkPh,
  type PaylinkAmountBucket,
  type PaylinkFlavor,
} from "../../lib/analytics"

/**
 * The `claimed` lifecycle event of a claim to Ethereum. The burn can outlive the screen that started
 * it (a broadcast recovered after an error, a closed tab), so the event is saved as the burn starts
 * and sent once its withdrawal record shows the burn mined on L2, by whichever surface sees that
 * first. Keyed by the record's `paylinkId`; only the link hash, flavor and amount range are kept, and
 * only while analytics is on. The write that drops a claim decides it is sent, so this browser
 * sends a claim at most once; delivery is the usual unacknowledged POST.
 */

/** Past the burn: the escrow is spent on L2, whatever the L1 leg does next. */
const mined = (r: WithdrawalRecord) => r.phase !== "submitting" && r.phase !== "failed"

/** Saves the claim this burn will make. Call before the burn is signed; never throws. */
export async function owePaylinkClaim(
  claims: OwedClaims,
  paylinkId: string,
  claim: {
    rollupAddress: string
    secret: { toBuffer(): Uint8Array }
    flavor: PaylinkFlavor
    amount: bigint
    decimals: number
  },
): Promise<void> {
  if (!analyticsEnabled()) return
  // Analytics must never hold up a claim.
  await bestEffort(
    "unknown",
    paylinkPh({ rollupAddress: claim.rollupAddress, secret: claim.secret }).then((ph) =>
      claims.owe({
        paylinkId,
        paylink_ph: ph,
        flavor: claim.flavor,
        amount_bucket: paylinkAmountBucket(claim.amount, claim.decimals),
        at: Date.now(),
      }),
    ),
  )
}

/** Sends every saved claim whose burn has mined, and forgets it. Never throws. */
export async function reportPaylinkClaims(
  records: readonly WithdrawalRecord[],
  claims: OwedClaims,
): Promise<void> {
  const isMined = (id: string) =>
    records.some((r) => r.paylinkId === id && r.intent !== "registration" && mined(r))
  const sent = await bestEffort("unknown", claims.settle(isMined, Date.now()))
  for (const claim of sent ?? [])
    firePaylinkEvent({
      stage: "claimed",
      // Saved by `owePaylinkClaim` from these types.
      flavor: claim.flavor as PaylinkFlavor,
      amount_bucket: claim.amount_bucket as PaylinkAmountBucket,
      paylink_ph: claim.paylink_ph,
    })
}

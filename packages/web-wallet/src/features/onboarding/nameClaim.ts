/**
 * NameClaim retrieval for consumers that need the signed claim itself (the manual registration
 * sweep's `domainAuth`): the device cache when it holds a live matching entry, else a re-request
 * from the claim server. The ledger replays a live claim for the same (device, name, account) and
 * reissues after expiry, so a lost or expired cache entry never strands a funded deposit.
 */

import type { Hex } from "viem"
import {
  claimRefusalReason,
  NameClaimStore,
  withClaimRetry,
  type NameClaimRecord,
  type NameClaimResponse,
  type PendingRegistrationRecord,
} from "@obsidion/front-core"
import { getConfig } from "../../config/env"
import { accountServiceFor, type OnboardingKeys } from "./oxideOnboarding"
import { rememberReissuedClaim } from "./registrationTerms"

/** Shown while a self-clearing refusal is waited out: nothing has failed yet. */
export const CLAIM_WAIT_NOTICE = "Waiting for this name's reservation to clear…"

/**
 * Copy for a refusal the wait ran out on. Each names a hold that ends by itself, on a name nobody
 * else can claim, so none of them may read as the name being taken.
 */
function selfClearingMessage(reason: string | undefined): string | undefined {
  switch (reason) {
    case "claim_conflict":
      return "This name is still reserved to another address on this device. That reservation clears by itself, so try the sweep again in a few minutes."
    case "claim_inflight":
    case "claim_superseded":
      return "A name claim for this device is still going through. Try the sweep again in a moment."
    default:
      return undefined
  }
}

/** The record's claim, from cache or re-requested; a refreshed claim is re-cached for the subscribe leg. */
export async function requireNameClaim(
  record: Pick<PendingRegistrationRecord, "account" | "tag" | "nameHash" | "l2Address"> &
    Partial<Pick<PendingRegistrationRecord, "fee">>,
  keys: Pick<OnboardingKeys, "secretKey">,
  opts: {
    onNotice?: (message: string) => void
    /** The controller's immutable fee, which prices a terms-less claim. Undefined when unread. */
    controllerFee?: bigint
  } = {},
): Promise<NameClaimRecord> {
  const store = NameClaimStore.get()
  const cached = await store.get(record.l2Address)
  const usable =
    cached &&
    cached.nameHash?.toLowerCase() === record.nameHash.toLowerCase() &&
    Number(cached.deadline) * 1000 > Date.now()
      ? cached
      : undefined
  // The account service is asked only when no cached claim can sweep the committed fee: a claim
  // signing that fee prices it, and so does a terms-less one where the controller's own fee is it.
  const pricesRecord =
    record.fee === undefined ||
    usable?.terms?.fee === record.fee ||
    (usable?.terms === undefined &&
      opts.controllerFee !== undefined &&
      opts.controllerFee === BigInt(record.fee))
  if (usable && pricesRecord) {
    return usable
  }

  let fresh: NameClaimResponse
  try {
    const accountService = accountServiceFor(getConfig(), keys)
    fresh = await withClaimRetry(
      () =>
        accountService.signDomain({
          nameHash: record.nameHash,
          userAddress: record.account as Hex,
        }),
      { onWait: () => opts.onNotice?.(CLAIM_WAIT_NOTICE) },
    )
  } catch (err) {
    const waitedOut = selfClearingMessage(claimRefusalReason(err))
    if (waitedOut) throw new Error(waitedOut, { cause: err })
    throw new Error(
      `Couldn't refresh the reservation for this name${
        err instanceof Error ? `: ${err.message}` : ""
      }`,
      { cause: err },
    )
  }
  const claim: NameClaimRecord = {
    address: record.l2Address,
    handle: record.tag,
    nameHash: record.nameHash,
    signature: fresh.signature,
    nonce: fresh.nonce,
    deadline: fresh.deadline,
    ...(fresh.terms ? { terms: { ...fresh.terms } } : {}),
  }
  await store.put(claim)
  rememberReissuedClaim(record, fresh)
  return claim
}

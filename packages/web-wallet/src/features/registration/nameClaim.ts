/**
 * NameClaim retrieval for consumers that need the signed claim itself (the manual registration
 * sweep's `domainAuth`): the device cache when it holds a live matching entry, else a re-request
 * from the claim server. The ledger replays a live claim for the same (device, name, account) and
 * reissues after expiry, so a lost or expired cache entry never strands a funded deposit.
 */

import type { Hex } from "viem"
import {
  claimRefusalReason,
  withClaimRetry,
  type NameClaimRecord,
  type NameClaims,
  type PendingRegistrationRecord,
  type RegistrationStore,
} from "@obsidion/front-core"
import type { NameClaimResponse } from "@obsidion/core/types"
import { WalletError, type ErrorCode } from "@obsidion/core/errors"
import type { OnboardingKeys } from "../../session/account"
import type { PageFacts } from "../../session/pageChain"
import { accountServiceFor } from "./registrationDeps"
import { rememberReissuedClaim } from "./registrationTerms"
import type { SignupStash } from "./signupStash"

/** Shown while a self-clearing refusal is waited out: nothing has failed yet. */
export const CLAIM_WAIT_NOTICE = "Waiting for this name's reservation to clear…"

/**
 * A refusal the wait ran out on. Each names a hold that ends by itself, on a name nobody else can
 * claim, so none of them may read as the name being taken.
 */
function selfClearingCode(reason: string | undefined): ErrorCode | undefined {
  switch (reason) {
    case "claim_conflict":
      return "registration.claimConflict"
    case "claim_inflight":
    case "claim_superseded":
      return "registration.claimInflight"
    default:
      return undefined
  }
}

/** The record's claim, from cache or re-requested; a refreshed claim is re-cached for the subscribe leg. */
export async function requireNameClaim(
  own: {
    nameClaims: Pick<NameClaims, "get" | "put">
    registrations: Pick<RegistrationStore, "apply">
    signup?: Pick<SignupStash, "grantToken">
    page: PageFacts
  },
  record: Pick<
    PendingRegistrationRecord,
    "account" | "tag" | "nameHash" | "l2Address" | "fee" | "sipaAddress" | "terms"
  >,
  keys: Pick<OnboardingKeys, "secretKey">,
  opts: {
    onNotice?: (message: string) => void
    /** The controller's immutable fee, which prices a terms-less claim. Undefined when unread. */
    controllerFee?: bigint
  } = {},
): Promise<NameClaimRecord> {
  const store = own.nameClaims
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
    usable?.terms?.fee === record.fee ||
    (usable?.terms === undefined &&
      opts.controllerFee !== undefined &&
      opts.controllerFee === BigInt(record.fee))
  if (usable && pricesRecord) {
    return usable
  }

  let fresh: NameClaimResponse
  try {
    const { config } = own.page
    const accountService = accountServiceFor(config, keys, own.signup?.grantToken(record.tag))
    fresh = await withClaimRetry(
      () =>
        accountService.signDomain({
          nameHash: record.nameHash,
          userAddress: record.account as Hex,
        }),
      { onWait: () => opts.onNotice?.(CLAIM_WAIT_NOTICE) },
    )
  } catch (err) {
    const waitedOut = selfClearingCode(claimRefusalReason(err))
    if (waitedOut) throw new WalletError(waitedOut, undefined, { cause: err })
    const reason = err instanceof Error ? err.message : String(err)
    throw new WalletError("registration.claimUnrefreshed", reason, { cause: err, data: { reason } })
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
  rememberReissuedClaim(own.registrations, record, fresh)
  return claim
}

import { WalletError } from "@obsidion/core/errors"
import { recipientNotUpgradedCopy } from "../migration/upgradeCopy"

/** The link declares decimals that the token it is paid in does not have. */
export class RequestDecimalsMismatchError extends Error {
  constructor(declared: number, actual: number) {
    super(`Request link declares ${declared} decimals; the token has ${actual}`)
  }
}

/** The requester's tag is still on a retired rollup, so nothing can deposit to it yet. */
export class RequesterNotUpgradedError extends Error {
  constructor(readonly tag: string) {
    super(recipientNotUpgradedCopy.title(tag))
    this.name = "RequesterNotUpgradedError"
  }
}

/**
 * Why the tag names another L2 account than the link pins. `moved`: the tag's account recorded the
 * pinned address before, as when a backup passkey moves the account to a new address. `otherOwner`:
 * it never did. `unknown`: its history could not be read.
 */
export type RequesterMismatch = "moved" | "otherOwner" | "unknown"

/** The refusal of a link whose tag names another L2 account; `data.reason` says why. */
export function requesterMismatch(tag: string, reason: RequesterMismatch): WalletError {
  return new WalletError("contact.requestMismatch", reason, { data: { tag, reason } })
}

/** Why something failed, as data. Copy for each code lives with the views. */
export type ErrorCode =
  | "tx.interrupted"
  | "tx.failed"
  | "tx.overGasLimit"
  | "balance.unread"
  | "scan.incomplete"
  | "refund.unchecked"
  | "withdrawal.interrupted"
  | "withdrawal.reorged"
  | "withdrawal.dropped"
  | "withdrawal.inactiveTab"
  | "withdrawal.failed"
  | "operation.running"
  | "operation.sent"
  | "sponsorship.paused"
  | "sponsorship.feesTooHigh"
  | "sponsorship.allowanceExhausted"
  | "sponsorship.unconfirmed"
  | "account.unlockFailed"
  | "account.creationCancelled"
  | "account.replaceUnconfirmed"
  | "account.locked"
  /** The page runs an account the tag's record has moved past; a reload opens the current one. */
  | "account.outdated"
  | "account.noPasskeyCredential"
  | "wallet.notReady"
  | "wallet.missing"
  | "onboarding.signupUnsaved"
  | "onboarding.linkMissing"
  | "registration.ticketRefused"
  | "registration.replaceWaiting"
  | "contact.unavailable"
  | "contact.unregistered"
  | "contact.requestMismatch"
  | "contact.cannotReceive"
  /** Another contact holds the address, tag, email or wallet. */
  | "contact.duplicate"
  | "contact.nameTaken"
  | "request.undelivered"
  | "messaging.anotherTab"
  | "messaging.unsupported"
  | "messaging.failed"
  | "messaging.starting"
  | "passkey.unasked"
  | "deposit.registrationMoved"
  | "migration.noResolverRegistry"
  | "deposit.broadcastDropped"
  | "deposit.sendHeld"
  | "deposit.holdUnsaved"
  | "deposit.broadcastFailed"
  | "deposit.addressRetired"
  | "deposit.addressUnpublished"
  | "deposit.belowFee"
  /** The bridge refused an amount under its fees. */
  | "bridge.belowFee"
  | "bridge.quoteFailed"
  /** A token's USD price could not be read, or its feed is stale. */
  | "price.unavailable"
  /** A bridge-out under the least burn that pays its escrow; `data.floor` is that burn, atomic. */
  | "withdraw.bridgeBelowFloor"
  | "withdraw.escrowRan"
  | "deposit.overCap"
  | "deposit.fundingReverted"
  | "deposit.fundingFailed"
  | "deposit.switchNetwork"
  | "deposit.mintUnavailable"
  | "savings.feeUnsettled"
  | "deposit.alreadySwept"
  | "deposit.untrackedEmpty"
  | "account.unlockWithPasskey"
  | "recovery.detailsPending"
  | "recovery.detailsPendingRetry"
  | "recovery.strandedEmpty"
  | "recovery.noEth"
  | "recovery.ethUnsupported"
  | "recovery.wrongChain"
  | "recovery.destinationMissing"
  | "recovery.locked"
  | "recovery.keysMismatch"
  | "recovery.noDeposit"
  | "recovery.addressesUnchecked"
  | "recovery.otherNetwork"
  | "recovery.notErc20"
  | "recovery.noDepositAnyVersion"
  | "recovery.previousVersionUnreadable"
  | "sweep.detailsPending"
  | "sweep.addressMismatch"
  | "sweep.reverted"
  | "sweep.revertedCapacity"
  | "sweep.tipDestinationMissing"
  | "sweep.capacity"
  | "sweep.ceiling"
  | "sweep.operationCap"
  | "sweep.belowFee"
  | "sweep.globalLimit"
  | "sweep.frozen"
  | "sweep.noRoute"
  | "sweep.noRouteUnnamed"
  | "sweep.addressBlocked"
  | "sweep.addressRefused"
  | "registration.sweepAddressMismatch"
  | "registration.priceCommitted"
  | "registration.quoteUnusable"
  | "registration.capUnread"
  | "registration.depositShort"
  | "registration.sweepReverted"
  | "registration.sweepRevertedCapacity"
  | "registration.claimConflict"
  | "registration.claimInflight"
  | "registration.claimUnrefreshed"
  | "registration.earnedUnconfirmed"
  | "registration.nameLocked"
  | "registration.nameConfirmed"
  | "registration.noBeneficiary"
  | "registration.ticketBelowThreshold"
  | "registration.ticketCannotCover"
  | "registration.restartWrongWallet"
  | "registration.earnedSameAddress"
  | "onboarding.alreadyClaimed"
  | "onboarding.alreadyClaimedOther"
  | "onboarding.tagMismatch"
  | "name.invalid"
  | "name.statusUnread"
  | "pastUser.unsigned"
  | "pastUser.unchecked"
  | "refund.registrationChanged"
  | "refund.depositUnavailable"
  | "refund.depositReached"
  | "refund.nothingHeld"
  | "refund.notRecovered"
  | "refund.incomplete"
  | "refund.receiptUnread"
  | "paylink.voucherUnread"
  | "paylink.termsMismatch"
  | "backupPasskey.changeMismatch"
  | "config.invalid"
  /** A holding feature binds no bridge in a role it needs; `detail` names the role. */
  | "holding.missingRole"
  /** A holding feature binds a bridge its deployment does not list. */
  | "holding.unknownBridge"
  /** A contract a holding feature needs is missing, malformed or zero; `detail` names it. */
  | "holding.unusableAddress"
  /** The wallet reads no holding of the feature's kind or conversion; `detail` names it. */
  | "holding.unsupported"
  /** A vault feature's deployment has no one usable executor feature; `detail` names why. */
  | "holding.noExecutor"
  /** The deployment lists more than one executor feature, so a move cannot pick one. */
  | "holding.duplicateExecutor"
  /** A holding's yearly rate could not be read; its figures show without one. */
  | "holding.rateUnread"
  /** No port serves the holding's rail, or no holding has the id; `detail` names which. */
  | "holding.noRoute"
  /** The move cannot be recovered: its rail or front cannot, or its route already ran. */
  | "move.noRecovery"
  /** The wallet does not list the holding, so it takes no move in; its funds can still leave. */
  | "move.exitOnly"
  /** The two holdings are not on one rail that swaps between its holdings; Sky's does not. */
  | "move.noVaultSwap"
  /** A move route's escrow factory or executor serves other portals than its holding's bridges. */
  | "move.routeMismatch"
  /** A move's route makes its burn's recovery data longer than a withdrawal is budgeted for. */
  | "move.routeTooLong"
  /** L1 failed while a move's route was read or quoted, its simulated run included. */
  | "move.routeUnread"
  /**
   * A move's costs leave nothing of its amount. `data.tips` is the bridge fee plus both tips,
   * in the burned token.
   */
  | "move.tipsExceedAmount"
  /** The recovery keys do not open the move's escrow. */
  | "move.recoveryKeysMismatch"
  /** The move's escrow holds none of the token a recovery returns: unpaid yet, or emptied. */
  | "move.escrowEmpty"
  /** The move's escrow holds nothing to run: it has run. */
  | "move.escrowRan"
  /** Less would land than the move's review showed; nothing was sent. */
  | "move.quoteChanged"
  /** A move out burns more shares than the network takes in one withdrawal. */
  | "move.overNetworkLimit"
  /** The source holds less than the move burns. */
  | "move.overspent"
  /** The co-signer a burn out of Savings needs could not be reached. */
  | "move.signerUnreachable"
  | "timeout"
  | "aborted"
  /** A broken programmer assumption; `detail` names it. */
  | "invariant"
  | "unknown"

/** What a record keeps of a failure. `detail` is debug text and is never rendered. */
export interface Failure {
  code: ErrorCode
  detail?: string
}

export class WalletError extends Error {
  /** Values for the `{name}` placeholders in the code's copy. */
  readonly data?: Readonly<Record<string, string>>
  constructor(
    readonly code: ErrorCode,
    readonly detail?: string,
    options?: { cause?: unknown; data?: Record<string, string> },
  ) {
    super(detail ?? code, options)
    this.name = "WalletError"
    this.data = options?.data
  }
}

/** `e` as a failure: a `WalletError` keeps its code, anything else takes `fallback`. */
export function toFailure(e: unknown, fallback: ErrorCode = "unknown"): Failure {
  if (e instanceof WalletError)
    return e.detail ? { code: e.code, detail: e.detail } : { code: e.code }
  return { code: fallback, detail: e instanceof Error ? e.message : String(e) }
}

/** Work whose failure must not fail the caller: it is logged under `code`, never dropped silently. */
export async function bestEffort<T>(code: ErrorCode, work: Promise<T>): Promise<T | undefined> {
  try {
    return await work
  } catch (e) {
    console.warn(`[${code}]`, e)
    return undefined
  }
}

/** No rule's work grows past this much text, and nothing beyond it helps triage. */
const SCRUB_LIMIT = 4_096

const SCRUBS: readonly (readonly [RegExp, string])[] = [
  [/\bMozilla\/\d[^\n]*/g, "[user-agent]"],
  [/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[url]"],
  // No part crosses an `@`, so a run of them cannot make the match backtrack for seconds.
  [/[^\s@]+@[^\s@]+/g, "[email]"],
  [/@[\w.-]+/g, "[tag]"],
  // Shortened around an ellipsis, as the wallet shows an address, or longer than a selector. It
  // needs no word boundary: an id can hold an address.
  [/0x(?:[0-9a-f]+(?:…|\.{2,})[0-9a-f]+|[0-9a-f]{9,})/gi, "[hex]"],
]

/**
 * An amount: grouped or decimal digits, or six and more. Never the digits inside a word. The first
 * group is a long key, id or encoded token: it holds a letter, and it stays whole so that a report
 * can be traced by it.
 */
const AMOUNT = /((?=[\d_-]*[A-Za-z])[\w-]{32,})|\b(?:\d+(?:[.,]\d+)+|\d{6,})/g

/**
 * Error text fit to leave for a third party: user agents, URLs, emails, tags, `0x` addresses and
 * hashes, and amounts become labels. A 4-byte selector, a short code and a long key or id stay, and
 * a label survives a second scrub. Text past `SCRUB_LIMIT` characters is dropped.
 */
export function scrubErrorText(text: string): string {
  let kept = text
  if (text.length > SCRUB_LIMIT) {
    // A cut can split a secret into a shape no rule knows, so the cut-off word goes with it.
    kept = text.slice(0, Math.max(0, text.slice(0, SCRUB_LIMIT + 1).search(/\s\S*$/)))
    if (!kept.trim()) kept = "[truncated]"
  }
  return SCRUBS.reduce(
    (scrubbed, [pattern, label]) => scrubbed.replace(pattern, label),
    kept,
  ).replace(AMOUNT, (_match, token?: string) => token ?? "[number]")
}

/** `bestEffort` for synchronous work: a throw is logged and `fallback` returned. */
export function bestEffortSync<T>(fn: () => T, fallback: T): T {
  try {
    return fn()
  } catch (e) {
    console.warn("[bestEffort]", e)
    return fallback
  }
}

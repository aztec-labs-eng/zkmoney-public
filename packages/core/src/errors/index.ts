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
  /** A holding's yearly rate could not be read; its figures show without one. */
  | "holding.rateUnread"
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

/** `bestEffort` for synchronous work: a throw is logged and `fallback` returned. */
export function bestEffortSync<T>(fn: () => T, fallback: T): T {
  try {
    return fn()
  } catch (e) {
    console.warn("[bestEffort]", e)
    return fallback
  }
}

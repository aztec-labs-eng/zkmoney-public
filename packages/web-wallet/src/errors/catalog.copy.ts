import type { ErrorCode } from "@obsidion/front-core"

export default {
  "account.unlockFailed": "Authentication failed. Tap retry to unlock your account.",
  "account.creationCancelled": "Security-key wallet creation was cancelled",
  "account.replaceUnconfirmed":
    "This device already has a wallet. Recovering a different security key here would replace it — " +
    "confirm 'replace this device's wallet' to proceed.",
  "account.locked": "the wallet is locked",
  "account.outdated":
    "This page is running an outdated account for your wallet. Refresh the page to continue.",
  "account.noPasskeyCredential":
    "no passkey credential id for the current account — cannot install the r1 key on registration",
  "tx.overGasLimit": "This transaction exceeds the network's gas limit and cannot be submitted.",
  "sponsorship.unconfirmed":
    "This transaction was not sent: zk.money could not confirm it is sponsored. Please try again " +
    "in a moment.",
  "wallet.notReady": "The wallet is still starting. Try again in a moment.",
  "wallet.missing": "wallet not found",
  "onboarding.signupUnsaved":
    "This signup's account was not saved. Reopen the payment link to continue.",
  "onboarding.linkMissing": "Open your payment link again to continue signup.",
  "registration.ticketRefused":
    "this payment's ticket did not waive the tag price, so the deposit is still the paid schedule",
  // Proposed copy, pending review.
  "registration.replaceWaiting":
    "The original address is still being published. Try again in a few minutes.",
  "contact.unavailable": "Contact or wallet identity unavailable",
  "contact.unregistered": "@{tag} is no longer registered",
  "contact.requestMismatch": "@{tag} no longer matches this payment request — payment cancelled",
  "contact.cannotReceive": "This contact can't receive requests yet",
  "request.undelivered": "Request delivery failed: {reason}",
  "messaging.anotherTab": "Wallet open in another tab — messaging paused here",
  "messaging.unsupported": "Messaging isn't supported in this browser — contacts still work",
  "messaging.failed": "Messaging couldn't start — it will retry when you return to this tab",
  "messaging.starting": "Messaging is still starting up — try again in a moment",
  "passkey.unasked": "The passkey that answered is not the one this browser asked for",
  "deposit.registrationMoved":
    "This deposit's registration has moved on, so the sweep was stopped before signing. Close and reopen the deposit for its current options.",
  "migration.noResolverRegistry": "The source deployment has no resolver registry",
  "deposit.broadcastDropped": "The network dropped the broadcast",
  "deposit.broadcastFailed": "The address was not published",
  "deposit.addressUnpublished": "This address is no longer published",
  "deposit.addressRetired": "This address is no longer in use",
  "deposit.sendHeld": "Another deposit from your browser wallet may still be sent.",
  "deposit.holdUnsaved": "This browser couldn't save the deposit's progress.",
  "deposit.belowFee": "Amount must exceed the deposit fee ({fee} {symbol})",
  "deposit.overCap": "This amount is over the network's maximum per deposit",
  "deposit.fundingReverted": "Funding transfer {hash} reverted",
  "deposit.fundingFailed": "The funding transaction failed or was replaced. Try again.",
  "deposit.switchNetwork": "Switch to the registration network first.",
  "deposit.mintUnavailable":
    "Minting test tokens isn't available through the browser bridge — use a browser with an injected wallet",
  "deposit.alreadySwept":
    "This deposit has already been swept. It will appear in your balance shortly.",
  "deposit.untrackedEmpty":
    "This deposit reads as already swept, but it predates token tracking — if it was made on an older deployment, report it from Settings before assuming the funds moved.",
  "account.unlockWithPasskey": "Unlock your wallet with your passkey and try again.",
  "recovery.detailsPending":
    "This wallet is still looking up this deposit's details. Recovery becomes available once it has them.",
  "recovery.detailsPendingRetry":
    "This wallet is still looking up this deposit's details. Try again once it has them.",
  "recovery.strandedEmpty": "This deposit address no longer holds any {symbol}.",
  "recovery.noEth": "This deposit address holds no ETH. It may already have been recovered.",
  "recovery.ethUnsupported":
    "This deposit address can't recover ETH. The ETH stays at the address.",
  "recovery.wrongChain": "Switch to the deposit's original chain before recovery",
  "recovery.destinationMissing":
    "Enter the Ethereum address that should receive the recovered funds.",
  "recovery.locked": "Unlock the wallet before recovery",
  "recovery.keysMismatch": "Wallet keys do not match this deposit's recovery account",
  "recovery.noDeposit":
    "This wallet has no deposit at that address. Open the wallet that made the address and try there.",
  "recovery.addressesUnchecked":
    "Couldn't check this wallet's registration addresses. Check your connection and try again.",
  "recovery.otherNetwork":
    "This deposit address is on another network. Switch networks and try again.",
  "recovery.notErc20": "That address is not an ERC-20 token on this network.",
  "recovery.noDepositAnyVersion": "This wallet has no deposit at that address on v6 or v5.",
  "recovery.previousVersionUnreadable":
    "Couldn't read v5. Check the old network node under Endpoints in Settings, then try again.",
  "sweep.detailsPending":
    "This wallet is still looking up this deposit's details. Sweeping becomes available once it has them.",
  "sweep.addressMismatch":
    "These deposit details point to a different address, so the sweep was stopped before signing.",
  "sweep.reverted":
    "Sweep transaction {hash} failed, and the wallet could not determine why. A relayer may have swept this deposit first, in which case it is already on its way into your balance.",
  "sweep.revertedCapacity":
    "Sweep transaction {hash} failed, and the wallet could not determine why. A relayer may have swept this deposit first, in which case it is already on its way into your balance. Network capacity is currently insufficient for this deposit.",
  "sweep.tipDestinationMissing": "Enter the Ethereum address that should receive the network tip.",
  "sweep.capacity":
    "Network capacity is currently insufficient for this deposit, so the sweep was stopped before signing. Check again later, or recover the deposit.",
  "sweep.ceiling":
    "This deposit is larger than the network's total deposit capacity, so it can't be swept. Recover it to an Ethereum address instead.",
  "sweep.operationCap":
    "This deposit is larger than the network can process in one deposit, so it can't be swept. Recover it to an Ethereum address instead.",
  "sweep.belowFee":
    "This deposit is at or below the network's deposit fee, so it can't be moved into your private balance. Recover it to an Ethereum address instead.",
  "sweep.globalLimit":
    "Network capacity is currently insufficient for this deposit, so the sweep did not go through. Check again later, or recover the deposit.",
  "sweep.frozen":
    "The network is not accepting deposits right now, so the sweep did not go through. You can recover the deposit.",
  "sweep.noRoute":
    "The network has no route for {symbol}, so it can't be swept. Recover it to an Ethereum address instead.",
  "sweep.noRouteUnnamed":
    "The network has no route for this token, so it can't be swept. Recover it to an Ethereum address instead.",
  "sweep.addressBlocked": "This address can't be used here. Use a different one.",
  "sweep.addressRefused": "{reason}",
  "registration.sweepAddressMismatch":
    "This claim's details point to a different deposit address, so the sweep was stopped before signing.",
  "registration.priceCommitted":
    "This address is registered at a different price. Recover the deposit, then register again at the current price.",
  "registration.quoteUnusable":
    "This quote cannot register this address yet. Try the sweep again in a moment.",
  "registration.capUnread":
    "This registration's deposit limit is not available yet. Try again in a moment.",
  "registration.depositShort":
    "The deposit does not yet cover this registration's fee and opening balance.",
  "registration.sweepReverted":
    "Sweep transaction {hash} failed, and the wallet could not determine why. A relayer may have swept this deposit first, or the deposit is below the registration total.",
  "registration.sweepRevertedCapacity":
    "Sweep transaction {hash} failed, and the wallet could not determine why. A relayer may have swept this deposit first, or the deposit is below the registration total. Network capacity is currently insufficient for this deposit.",
  "registration.claimConflict":
    "This name is still reserved to another address on this device. That reservation clears by itself, so try the sweep again in a few minutes.",
  "registration.claimInflight":
    "A name claim for this device is still going through. Try the sweep again in a moment.",
  "registration.claimUnrefreshed": "Couldn't refresh the reservation for this name: {reason}",
  "registration.earnedUnconfirmed":
    "Your earned tag price has not been confirmed yet. Wait a few minutes, then try again.",
  "registration.nameLocked":
    "Your first deposit has reached your address, so your name cannot change here.",
  "registration.nameConfirmed": "Your name is confirmed and cannot change during registration.",
  "registration.noBeneficiary":
    "the registration controller allowlists no fee beneficiary, so a registration cannot be priced",
  "registration.ticketBelowThreshold": "this payment is below the amount that waives the tag price",
  "registration.ticketCannotCover": "this payment cannot cover the account deposit",
  "registration.restartWrongWallet": "Use the original wallet to restart this registration.",
  "registration.earnedSameAddress":
    "The earned quote did not produce a new address for this wallet.",
  "onboarding.alreadyClaimed": "this passkey already claimed {name} — use Enter instead",
  "onboarding.alreadyClaimedOther":
    "this passkey already claimed another tag — use Enter to recover it",
  "onboarding.tagMismatch": "@{handle} is not the tag this passkey claimed",
  "pastUser.unsigned": "The wallet did not sign the message. Try again.",
  "pastUser.unchecked": "The check did not finish. Try again.",
  "refund.registrationChanged": "This registration changed. Reopen its status before continuing.",
  "refund.depositUnavailable":
    "The original deposit details are not available yet. Unlock this wallet and try again.",
  "refund.depositReached":
    "A deposit reached this address. Recover it before requesting a new address.",
  "refund.nothingHeld":
    "No funds remain at this address. Check its recovery or registration status.",
  "refund.notRecovered": "Recover the original deposit before requesting a new address.",
  "refund.incomplete":
    "The original refund is not complete. Check it before requesting a new address.",
  "refund.receiptUnread": "A refund receipt could not be read. Try again.",
  "paylink.termsMismatch": "This link doesn't match its escrow",
  // Proposed copy for the bridge refusals, pending review.
  "bridge.belowFee": "This amount is too small to cover the bridge fee.",
  "bridge.quoteFailed": "Couldn't get a bridge quote. Try again.",
  "withdraw.bridgeBelowFloor": "This amount is too small to bridge.",
  "withdraw.escrowRan": "This escrow has already run. The record will update shortly.",
  // Proposed copy for the Savings move refusals, pending review.
  "move.routeMismatch": "Savings changed on the network since this move was set up. Try again.",
  "move.tipsExceedAmount": "This amount does not cover the L1 fees. Try a larger amount.",
  "move.recoveryKeysMismatch":
    "This move's recovery key doesn't match this account, so it can't be recovered here.",
  "move.quoteChanged": "Fees went up since your review. Nothing was sent.",
  "move.escrowRan": "This move's escrow has already run. Savings will update shortly.",
  "move.noRecovery": "This move has nothing left to recover. Savings will update shortly.",
  "move.escrowEmpty": "This move has nothing left to recover. Savings will update shortly.",
  "move.overNetworkLimit": "This withdrawal is over the network's maximum per withdrawal.",
  "move.overspent": "Balance not enough",
  "move.signerUnreachable": "The Savings co-signer isn't reachable. Try again in a moment.",
  // Proposed copy for the two operation refusals, pending review.
  "operation.running": "This transaction is already in progress.",
  "operation.sent": "This transaction was already sent.",
  "unknown": "Something went wrong. Try again.",
} as const satisfies Partial<Record<ErrorCode, string>>

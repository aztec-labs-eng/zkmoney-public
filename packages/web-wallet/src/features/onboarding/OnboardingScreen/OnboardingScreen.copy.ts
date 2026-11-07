export default {
  busy: {
    passkey: "Confirm your passkey…",
    checking: "Checking your claim…",
    claiming: "Claiming your payment…",
  },
  paylinkStage: {
    ticket: "Proving your ticket…",
    reserve: "Reserving @{tag}…",
    setup: "Setting up @{tag}…",
    checking: "Checking your payment…",
  },
  handleUnverified: "Couldn't verify that handle{detail}. Try again.",
  handleUnverifiedDetail: " — {message}",
  drawFailed: "Couldn't pick a tag for you. Try again.",
  retryEnter: "Retry entering wallet",
  claimFailed: "The claim could not be completed. Activate account to try again.",
  passkeyMismatch:
    "That isn't the passkey this claim was started with — try again with the passkey you signed up with.",
  passkeyNotOffered:
    "Couldn't find your passkey on this device — use the device you signed up on, or check status here.",
  activate: "Activate account",
  instantAccess: "Get instant access",
  pendingTitle: {
    recover: "Recover deposit for @{tag}",
    received: "Deposit received for @{tag}",
    refresh: "Refresh the deposit for @{tag}",
    claiming: "Claiming @{tag}…",
  },
  pendingBody: {
    refunded:
      "The original deposit was recovered. Request a new address at the earned price, then fund that address. Do not send more to the old address.",
    refundAdmitted:
      "Your wallet is open. The old deposit address cannot use the earned price. Recover its funds before requesting a new address.",
    refund:
      "The old deposit address cannot use the earned price. Recover its funds before requesting a new address. Do not send more to it.",
    admitted:
      "Your deposit opened the wallet. Registration is still pending. Check its status or retry if needed. Do not send another deposit.",
    urgent: "@{tag} is taking longer than usual. It is still reserved and still being confirmed.",
    received:
      "Your deposit is in. The name is being confirmed on-chain and you can enter the wallet now.",
    replaceUnfunded:
      "The earned price differs from this registration's original quote. Nothing was sent to the original address, so request a new one at the earned price.",
    quoteMismatch:
      "The earned price differs from this registration's original quote. We are checking the existing deposit. Do not send another deposit.",
    expired:
      "The deposit amount for @{tag} needs a refresh. Refresh it to get the current amount and deposit address.",
    paused: "@{tag} is held for you. No deposit is needed right now.",
    sweeping: "Registering @{tag}. Waiting for the network to sweep the deposit.",
    paylink: "@{tag} is reserved. This payment funds the account — confirm to claim it.",
    awaiting:
      "@{tag} is reserved for you. Send the deposit to the address below and the tag is yours when the deposit arrives on zk.money.",
    confirming: "Your claim is being confirmed. This can take a moment.",
  },
  retry: "Retry",
  checked: "Checked {when} · ",
  justNow: "just now",
  minutesAgo: "{minutes}m ago",
  checkAgain: "Check again",
  checking: "Checking…",
  back: "Back",
  unsavedSignup:
    "The previous attempt did not finish saving this signup. No ticket was redeemed. Creating another passkey starts a new account; the previous passkey may remain in your password manager.",
  startOver: "Start over",
  ticket: {
    amountUnread: "Couldn't check this payment's amount. Go back to the payment and try again.",
    uncovered: "This payment cannot cover the account deposit.",
    nameUncovered:
      "This payment cannot cover the name, so you deposit for it. The payment goes to your balance.",
    feeChecking: "Still checking the network fee…",
    feeUnread: "Couldn't check the network fee.",
    tryAgain: "Try again",
  },
  busyLabel: {
    preparing: "Preparing deposit address…",
    confirming: "Confirming with your passkey…",
    probing: "Checking this browser…",
    creating: "Creating your passkey…",
  },
  cta: {
    anotherPasskey: "Create another passkey",
    continuePasskey: "Continue with your passkey",
    createAccount: "Create account with passkey",
    deposit: "Deposit {total}",
  },
  later: "I'll do this later",
  sheetLabel: "Account setup",
  draftTitle: "Create account for",
  existing: {
    label: "Existing deposit status",
    address: "Original deposit address",
    detected: "Deposit detected:",
    processing: "Your deposit is being processed.",
  },
  earned: {
    label: "Complete earned registration",
    capacity:
      "The new address has received your deposit. Sweep manually finishes registration once network capacity is available.",
    tooLarge: "The new address has received your deposit, but it is too large to sweep.",
    sweep:
      "The new address has received your deposit. Choose Sweep manually to finish registration.",
    refundedPrefix: "The original deposit was refunded. ",
    fund: "{refunded}Fund this new address with the earned {ask} total, then choose Sweep manually to finish registration.",
    gas: "The connected Ethereum wallet pays gas.",
  },
  logOut: "Log out",
  refreshAmount: "Refresh deposit amount",
  claimPayment: "Claim your payment",
  backToWallet: "Back to wallet",
  enterLater: "Enter now, deposit later",
  continue: "Continue",
} as const

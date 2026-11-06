export default {
  hold: {
    preparing: "Getting your wallet ready to claim your payment.",
    countdown: "{countdown}. New links wait a moment so the sender can cancel a mistake.",
  },
  moment: " This only takes a moment.",
  activateLabel: "Activate @{tag}",
  claiming: "Claiming @{tag}",
  claimPayment: "Claim your payment",
  ticket: {
    heldFor: " until {date}",
    title: {
      held: "Claiming @{tag} shortly",
      blocked: "This payment cannot fund @{tag}",
      renew: "Refresh your reservation",
      open: "Open your payment link",
    },
    body: {
      claiming: "Claiming your payment and setting up your account.",
      rail: "{rail}. This only takes a moment.",
      submitted:
        "Payment claimed. @{tag} registers once the network sweeps the deposit. Nothing to send.",
      ready: "@{tag} is reserved{heldFor}. The payment you were sent funds it. Claim it to finish.",
      blocked: "The renewed price is not one the payment covers. Check on the registration.",
      renew: "The reservation for @{tag} needs a fresh quote. Open it to renew.",
      open: "@{tag} is reserved{heldFor}. Open the payment link you were sent again to claim it and fund the tag.",
    },
  },
  recovery: {
    label: "Check registration for @{tag}",
    title: "Registration needs recovery",
    refunded: "Your wallet is open. The old deposit was recovered. Register at the earned price.",
    recover: "Your wallet is open. Recover the old deposit, then register at the earned price.",
    pending:
      "Your wallet is open. Registration for @{tag} is still pending. Check its status. Do not send another deposit.",
  },
  fundsIn: {
    stuck: "This is taking longer than expected. Check on it.",
    stage: "{stage}.{moment}",
    funding: "Securing your tag",
    received: "Deposit received",
  },
  linkFunding: {
    amountUnknown: "The payment",
    amount: "The {amount}",
    checkingLabel: "Checking your payment",
    claimLabel: "Claim your payment for @{tag}",
    checkingTitle: "Checking your payment…",
    checkingBody: "Seeing whether the payment you were sent pays for @{tag}.",
    claimBody: "{amount} you were sent pays for @{tag}. Claim it to finish.",
  },
  deposit: {
    held: "Reserved until {date}, {time}.",
    free: "The tag is free.",
    title: {
      stale: "Refresh your deposit",
      paused: "Activation is paused",
      unpublished: "Activate account",
    },
    stale: "The deposit amount needs a refresh. Open it to get the current amount.",
    unpublished: "{held}Your deposit address was not published. Check on it to try again.",
  },
  registerName: {
    title: "Pick your name",
    body: "People pay a name, not an address. Register yours whenever you are ready.",
    action: "Register a name",
  },
} as const

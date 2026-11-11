/** The request landing page's own words, where they differ from the catalog's. */
export default {
  /** Why a link can't be paid, keyed by the page's problem. */
  problems: {
    unknownPayee: "There's no zk.money account with this name.",
    requesterMismatch: "@{tag} no longer matches this payment request",
    expired: "This payment request has expired.",
    wrongNetwork: "This payment request is for a different network.",
    wrongToken: "This payment request is for a token this wallet doesn't support.",
    legacyUnverifiable:
      "This link is from an older app version and can't be paid from the web without an account — sign up, or open it in the zk.money app.",
    // Proposed copy, pending review.
    requesterMoved: "@{tag} moved to a new account. Ask them for a new request link.",
    requesterChanged: "@{tag} now belongs to a different account. Don't pay this link.",
  },
  payWithWallet: "Pay with a wallet",
  publicPayment: "Public onchain payment.",
  feePublicPayment: "A fee applies. Public onchain payment.",
  feeApplies: "A fee applies.",
  chooseHowToPay: "Choose how to pay",
  /** Over the pay buttons when the link's @tag could not be checked against its address. */
  tagWarning: "{warning} — check with them before sending.",
  tagWarnings: {
    unregistered: "@{tag} is no longer registered",
    // Proposed copy, pending review.
    unchecked: "We couldn't look up @{tag}",
  },
} as const

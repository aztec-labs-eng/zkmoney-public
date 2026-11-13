export default {
  bridging: {
    chip: "Bridging",
    title: "Bridging your {coin}",
    line: "{amount} from {chain} to your private balance.",
  },
  arriving: {
    line: "Your {amount} is confirmed and arriving as ≈ {landing}.",
  },
  paying: {
    title: "Paying @{payee}",
    line: "{amount} from {chain} to @{payee}.",
  },
  failed: {
    expired:
      "The bridge didn't deliver your {amount} in time. It's being returned to your wallet on {chain}.",
    refunded:
      "The bridge didn't deliver your {amount} in time. It's back in your wallet on {chain}.",
    /** The bridge carried another token than the one sent, and refunds that one. */
    expiredAs:
      "The bridge didn't deliver your {amount} in time. It's being returned as {returned} to your wallet on {chain}.",
    refundedAs:
      "The bridge didn't deliver your {amount} in time. It's refunded as {returned} and back in your wallet on {chain}.",
    notSent: "The transaction didn't go through. Your {amount} stayed in your wallet.",
  },
} as const

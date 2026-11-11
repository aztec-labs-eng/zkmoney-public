export default {
  bridging: {
    title: "Bridging your {coin}",
    line: "{amount} from {chain} to your private funds.",
  },
  arriving: {
    line: "Your {amount} reached {network} as ≈ {landing}.",
  },
  about: "About {minutes} min.",
  paying: {
    title: "Paying @{payee}",
    line: "{amount} from {chain} to @{payee}.",
  },
  failed: {
    expired:
      "The bridge didn't deliver your {amount} in time. It's being returned to your wallet on {chain}.",
    refunded:
      "The bridge didn't deliver your {amount} in time. It's back in your wallet on {chain}.",
    notSent: "The transaction didn't go through. Your {amount} stayed in your wallet.",
  },
} as const

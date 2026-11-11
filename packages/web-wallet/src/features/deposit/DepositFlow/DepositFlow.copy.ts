export default {
  label: "Deposit",
  title: "Deposit funds",
  /** The intro step a payment opens on. */
  intro: {
    from: "Deposit from",
    noteBridge: "Connect the wallet holding your {coin} on {network} to bridge.",
    continue: "Continue",
  },
  method: {
    title: "How are you sending it?",
    address: "Show deposit address",
    addressDetail: "Send from any exchange or wallet",
    soon: "Coming soon",
    /** Followed by the L1's name as a link that switches to it, then `l1OnlyAfter`. */
    l1Only: "Deposit addresses work on {network} only. Switch to",
    l1OnlyAfter: "or connect your wallet above.",
    wallet: "Connect wallet",
    walletBridge: "Bridge from your wallet on {network}",
    walletSend: "Send from your wallet on {network}",
  },
} as const

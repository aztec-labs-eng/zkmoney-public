export default {
  checking: "Checking address history…",
  continue: "Continue",
  // Proposed: an ether.fi Cash address pasted into the fresh-address flow.
  etherfi: {
    title: "This is an ether.fi Cash address",
    body:
      "ether.fi Cash credits only USDC or USDT, so the DAI and the ETH for gas this sends would " +
      "not reach your Cash balance. Withdraw to ether.fi instead.",
    action: "Withdraw to ether.fi",
  },
} as const

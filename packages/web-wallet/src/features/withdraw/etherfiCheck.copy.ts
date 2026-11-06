export default {
  // Proposed: the fresh and existing-address flows, when ether.fi could not be asked.
  unknown: {
    title: "Couldn't check this address with ether.fi",
    body:
      "If it's an ether.fi Cash address, withdraw to ether.fi instead. Cash credits only USDC " +
      "or USDT.",
  },
} as const

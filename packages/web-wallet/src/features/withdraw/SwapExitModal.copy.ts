export default {
  started: "Started",
  to: "To",
  runSwap: "Run the swap now",
  runMove: "Run the move now",
  moveRun:
    "No relayer has run this move. You can run it yourself: the funds go on to {to}, the tip this move set aside for whoever runs it comes back to your wallet, and you pay only the gas. If a relayer gets there first this transaction completes without doing anything.",
  moveRecoverInstead: "Or send the DAI to an Ethereum address instead of moving it.",
  moveSent: "Move sent on",
  moveSentTo: "Sent on to {to}. It shows there once it is claimed.",
  moveRecover:
    "No relayer has run this move, and none will. Send the DAI to an Ethereum address instead.",
} as const

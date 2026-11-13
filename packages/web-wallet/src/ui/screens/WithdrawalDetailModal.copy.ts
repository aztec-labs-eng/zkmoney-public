export default {
  sent: "Sent",
  recipientReceived: "Recipient received",
  recipientReceives: "Recipient receives",
  minimumReceived: "Minimum received",
  releasingTo: "Releasing to {chain}",
  facts: {
    status: "Status",
    to: "To",
    txHash: "Tx hash",
    from: "From",
    paymentLink: "Payment link",
    token: "Token",
    network: "Network",
    l1Tx: "L1 tx",
    finalizationTx: "Finalization tx",
    swapTx: "Swap tx",
    recoveredTo: "Recovered to",
    recoveryTx: "Recovery tx",
    exchangeRate: "Exchange rate",
    arrivesAsGas: "Arrives as gas",
    fee: "Fee",
    oldVersionFee: "Old version fee",
    newVersionFee: "New version fee",
    youllReceive: "You'll receive",
  },
  // Proposed: folds the address, hashes, token and network away.
  details: "Details",
  // Proposed: a backup passkey fee's sheet.
  backup: {
    hold: "Temporary hold",
    heldNote: "{amount} is returned to your balance when your backup passkey is active.",
    adding: "Your backup passkey is being added.",
    finishYourself:
      "This is taking longer than usual, so you can send the Ethereum transaction that finishes this payment yourself.",
    failed: "This payment did not go through.",
  },
} as const

export default {
  publishing: "Getting your fresh deposit address ready.",
  tag: "@{tag}",
  domain: ".zk.money",
  reservedUntil: "Reserved until {date}, {time}",
  received: "Deposit received. Confirming your name.",
  receivedAmount: "Deposit received: {amount}. Confirming your name.",
  openingBalance: "Your opening balance is set when your {symbol} arrives.",
  summary: {
    tagFree: "The tag is free. ",
    seen: "{amount} received. ",
    confirming: "Confirming your deposit amount.",
    remaining: "{seen} of {total} received. Send at least {remaining} more to the address below.",
    free: "Send at least {amount} to activate your account. The tag is free.",
    freeFunding:
      "Send at least {amount} to activate your account. The tag is free, and {funding} is network funding.",
    claim: "Send at least {amount} to claim your tag and activate your account.",
  },
  network: "on {logo} {chain}",
  otherTokens:
    "Other tokens need manual recovery from Settings. Other networks can't be recovered.",
  waitingRemaining: "{seen} of {total} received · Send at least {remaining} more",
  balance: "Balance at this address: {amount}",
  aboutLimit: "About the deposit limit",
  paylink:
    "The fees come out of the payment to register your tag; the remainder stays in your wallet. Registration can take up to 40 minutes.",
} as const

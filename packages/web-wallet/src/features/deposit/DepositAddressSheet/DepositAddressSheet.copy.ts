export default {
  label: "Deposit address",
  close: "Close",
  walletLabel: "Or connect a wallet to fund",
  arrivalFew: "a few minutes",
  arrivalMinutes: "{minutes} minutes",
  title: {
    creating: "Creating your address...",
    ready: "Send {symbol} to this address",
    waiting: "Waiting for your {symbol}",
  },
  subtitle: {
    creating: "Just a moment. You'll copy it into your exchange or wallet next.",
    ready:
      "Copy it into your exchange or wallet and send {symbol} on {chain}. Then wait, we'll tell you when it lands.",
    waiting:
      "Send {symbol} on {chain} to the address below. It shows up here as soon as the network sees it.",
  },
  copied: "Address copied",
  copy: "Copy address",
  waitingForAddress: "Waiting for address...",
  address: "Address",
  status: "Status",
  awaiting: "Awaiting deposit",
  qr: "Deposit address QR code",
  chip: "Copied",
  spotted: {
    title: "{amount} spotted",
    arriving: "≈ {amount} is on its way to your private funds.",
    sent: "{amount} is on its way to your private funds.",
    swapping:
      "It's being swapped to {token} at the market rate, less the fee, on its way to your private funds.",
    capacityChip: "Waiting for capacity",
    capacity:
      "This deposit is over what the network can take right now. It's credited once capacity frees up, which can take longer than {arrival}.",
    limit:
      "This deposit is over the {limit} limit, so it can't be credited as is. Recover it to an Ethereum address from Activity.",
    limitFallback: "deposit",
    limitNote:
      "Recovery sends the whole amount to an Ethereum address you choose. The deposit shows in Activity with a Recover button.",
  },
  openActivity: "Open Activity",
  balance: "Balance at this address: ${amount}",
  waiting: "Waiting...",
  copiedCta: "Address copied!",
  copyAgain: "Copy address again",
  limits: "Limits and fees",
  limitNow: "Up to {limit} right now",
} as const

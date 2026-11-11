export default {
  label: "Deposit status",
  sending: {
    title: "Sending your {coin}",
    line: "{amount} from {wallet} to your private funds.",
    payeeLine: "{amount} from {wallet} to @{payee}.",
  },
  yourWallet: "your wallet",
  arriving: {
    line: "Your {amount} is confirmed on {network} and arriving as {landing}.",
  },
  failed: {
    title: "Deposit didn't complete",
    line: "The deposit couldn't be completed. Your {amount} is still at your deposit address.",
  },
} as const

export default {
  signNote:
    "You'll sign a message to prove the wallet is yours, no gas, no transaction, and we can never move your funds. The signature is checked in ZK, so your address is never linked to your tag and we never see it.",
  close: "Close",
  confirmed: {
    title: "Welcome back",
    bodyTag: "This wallet had a zk.money account. @{tag} is free for you.",
    body: "This wallet had a zk.money account. Your own tag is free: pick the name people pay you at.",
    claimTag: "Claim @{tag} for free",
    choose: "Choose my tag",
    keepRandom: "Keep a random tag instead",
  },
  claimed: {
    title: "This address has already been claimed",
    body: "Please try verifying using a different address.",
    retry: "Try another address",
  },
  notFound: {
    title: "No zk.money account found",
    body: "This wallet never had a zk.money account. Try the wallet you signed in with back then, or continue with a random tag for free.",
  },
  checking: {
    title: "Checking your wallet",
    body: "Looking for a zk.money account for this wallet. This takes a few seconds.",
    button: "Checking…",
  },
  title: "Verify your old wallet",
  privacy:
    "Your wallet address stays on your device. It is never sent to zk.money and never linked to your tag.",
  lede: "Sign a message with the Ethereum wallet you used on zk.money. You can choose your own tag for free.",
  connect: {
    use: "Use {address}",
    title: "Connect the wallet you used",
    connected: "Connected{with}",
    connectedWith: " with {name}",
    options: "Use WalletConnect, Rainbow, or MetaMask",
  },
  disconnect: "Disconnect",
  or: "or",
  signing: "Confirm in your wallet…",
  sign: "Sign to verify",
  pickInstead: "Don’t have it anymore? Pick a tag instead",
} as const

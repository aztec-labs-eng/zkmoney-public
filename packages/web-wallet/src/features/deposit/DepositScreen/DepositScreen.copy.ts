export default {
  info: {
    head: "Important information",
    lossTitle: "Risk of loss",
    lossBody:
      "Only send available tokens on Ethereum. Anything else is not credited, and getting it back requires manual recovery.",
    rotatesTitle: "Each deposit gets a new address",
    rotatesBody:
      "Addresses you already shared keep working. Use each one only once for the best privacy.",
  },
  userNotFound:
    "This @tag isn't registered on the current network — your saved login is likely from a previous deployment. Clear site data and claim again.",
  /** The Fee row while the quote is still being read. */
  quotePending: "Checking…",
  /** What to do when the fee read failed and the funding controls are held. */
  feeUnavailableNote: "Use Retry to load the fee and continue.",
  titleActivate: "Deposit to activate your account",
  title: "Deposit funds",
  limits: {
    minimum: "Minimum deposit",
    aboutLimit: "About the deposit limit",
    now: "Limit right now",
    nowValue: "{limit} incl. fees",
    unchecked: "Could not check",
    aboutCapacity: "About network capacity",
    fee: "Fee",
    unavailable: "Unavailable",
    aboutFee: "About the deposit fee",
    retry: "Retry",
    arrival: "Deposit arrival time",
    arrivalUnknown: "A few minutes",
    arrivalMinutes: "~{minutes} minutes",
  },
  tagFallback: "your @tag",
  fromWallet: "Deposit from {wallet} · {address}",
  walletFallback: "wallet",
  fromBrowser: "Or deposit from your browser",
  connectWallet: "Or connect a wallet to fund",
  disconnect: "Disconnect",
  claiming: {
    checkTitle: "Registration needs a check",
    title: "Claiming {tag}",
    checkBody: "Check on {tag} before you deposit.",
    body: "Your tag is still being claimed. {status}",
    slow: "This is taking longer than usual. Check on it.",
    usual: "This usually takes about a minute.",
    note: "Deposit addresses will be available here once {tag} is successfully registered.",
  },
  hold: {
    waitingTitle: "Waiting for your browser wallet",
    waitingBody:
      "A transfer to {address} may still be sent from your browser wallet. If it is, the deposit appears in your activity.",
    unreadTitle: "Deposit state unavailable",
    unreadBody: "This browser's saved deposit state can't be read.",
    paused: "New deposits are paused here so the same funds are not sent twice.",
    writeFailed: "This browser couldn't update its saved state. Try again.",
    viewActivity: "View activity",
    checkAgain: "Check again",
    restart: "Start a new deposit",
  },
  yourName: "Your name",
  chooseOwn: "Choose your own",
  keepOrChoose:
    "Keep @{tag} or choose your own. Once you confirm, your name can't change while it registers.",
  keep: "Keep @{tag}",
  whichToken: "Which token are you sending?",
  network: "Network",
} as const

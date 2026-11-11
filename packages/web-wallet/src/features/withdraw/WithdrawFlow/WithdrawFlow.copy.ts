export default {
  label: "Withdraw",
  title: "Withdraw",
  continue: "Continue",
  address: {
    label: "Paste the address",
    field: "Address",
    placeholder: "0x… or ENS name",
    paste: "Paste",
    clear: "Clear address",
    name: "Name this address",
    namePlaceholder: "Rainbow",
    ens: {
      resolving: "Looking up this name…",
      missing: "No address resolution found for this name.",
      invalid: "This isn't a valid ENS name.",
      error: "Couldn't look up this name. Try again, or paste the address.",
    },
    screening: {
      checking: "Checking address…",
      blocked: "This address can't receive withdrawals.",
      /** Screening or an address read did not answer. */
      unreachable:
        "Couldn't verify this address. Check your internet connection or try another address.",
      retry: "Retry",
    },
    historyChecking: "Checking address history…",
    etherscan: "Want to check address's onchain history?",
    openEtherscan: "Open Etherscan",
    or: "or",
    connect: "Connect your wallet",
    connectDetail: "Use MetaMask, Rainbow and more",
    connected: "Use your connected wallet",
    connectedDetail: "{wallet} · {address}",
    walletFallback: "Wallet",
  },
  etherfi: {
    title: "Withdraw to ether.fi",
    subtitle: "Funds land in your ether.fi Cash balance. {assets}.",
    steps: [
      "Open ether.fi Cash and go to Add funds, then Crypto, then Share address.",
      "Copy the address it shows.",
      "Paste it below. Only USDC or USDT reach your Cash balance.",
    ],
    change: "Change",
    getAddress: "Get your ether.fi address",
    getAddressHint: "Opens ether.fi Cash in a new tab",
    field: "ether.fi Cash address",
    placeholder: "Paste the address from ether.fi",
    notAnAddress: "That isn't an Ethereum address.",
    save: "Save as my ether.fi address",
    checking: "Checking with ether.fi…",
    verdict: {
      confirmed: {
        title: "ether.fi Cash address confirmed",
        body: "ether.fi's deposit factory on Ethereum deployed this address.",
      },
      account: {
        title: "Confirm this ether.fi Cash address",
        body:
          "ether.fi created this Cash account, but it hasn't received funds on Ethereum " +
          "before. Check it matches the address in your ether.fi app before you continue.",
      },
      rejected: {
        title: "This isn't an ether.fi Cash address",
        body:
          "ether.fi has no record of it on Ethereum or Optimism. Funds sent here would not " +
          "reach a Cash balance. Copy the address from ether.fi's share-address page.",
      },
      unknown: {
        title: "Couldn't confirm this is an ether.fi address",
        body: "The check did not finish. Make sure the address came from ether.fi before you continue.",
      },
    },
  },
  /** One phrase per ring segment, joined into the privacy card's summary. */
  privacy: {
    activity: { clear: "no transactions", weak: "has transactions" },
    linked: { clear: "never used with zk.money", weak: "used with zk.money before" },
    identity: { clear: "no public name", weak: "has a public name" },
    /** The same phrases opening a sentence. */
    lead: {
      activity: { clear: "No transactions", weak: "Has transactions" },
      linked: { clear: "Never used with zk.money", weak: "Used with zk.money before" },
      identity: { clear: "No public name", weak: "Has a public name" },
    },
    /** The answered phrases as one sentence, by how many answered. */
    summary: {
      one: "{first}.",
      two: "{first}, {second}.",
      three: "{first}, {second}, {third}.",
    },
  },
  unpriced: "$--",
  pending: "…",
  amount: {
    subtitle: "To {name}",
    who: "{name} · {address}",
    balanceLabel: "Private balance",
    handle: "{handle}.zk.money",
    amount: "Amount",
    quoteFailed: "Couldn't get a quote. Check the amount and try again.",
    noSwapStack: "Swaps aren't offered on this network. Withdraw DAI instead.",
    feeMoved:
      "The fee has changed and the amount no longer covers it. Go back and adjust the amount.",
    overspent: "Balance not enough",
    contract: {
      title: "This address is a contract",
      body: "ETH arrives as a plain transfer, which a contract can reject. Pick USDC or USDT, or a different address.",
    },
  },
  picker: {
    title: "Withdraw funds",
  },
  gas: {
    title: "Add gas?",
    subtitle: "Optional · to {name} on Ethereum",
    label: "ETH for gas",
    noEth: "No ETH on Ethereum",
    hasEth: "Has ETH on Ethereum",
    hasEthBody:
      "{name} already has ETH on Ethereum to pay gas when moving funds. You can add more if you'd like.",
    noEthBody:
      "{name} has no ETH on Ethereum to pay gas. Add a little so you can move funds from this account later.",
    other: "Add a little ETH so {name} can move the funds.",
    none: "None",
    chip: "${amount}",
    share: "≈ {gas} of ETH lands with {received} {coin}.",
    noShare: "{received} {coin} lands without ETH for gas.",
    extraFee: "+{fee} fee",
    quoting: "Quoting the fee…",
    with: "Continue with {gas} of gas",
    without: "Continue without gas",
  },
  review: {
    send: "{amount} DAI",
    receive: "≈ {received} {coin}",
    gas: "≈ {gas} of ETH, included",
    fee: "Fee",
    bridgeFee: "Fee",
    feeBreakdown: {
      withdrawal: "Withdrawal fee",
      fast: "Speed-up fee",
      gas: "Gas top-up fee",
      bridge: "Bridging fee",
    },
    speedLabel: "Speed",
    standard: "Standard",
    fast: "Fast",
    speed: "{speed} · {eta}",
    network: "Ethereum",
    confirm: "Withdraw privately",
    connecting: "Connecting…",
    feeChanged: "The fee changed. Check the new amounts before confirming.",
  },
  status: {
    label: "Withdrawing",
    title: "Withdrawing to {chain}",
    releasing: "Releasing to {chain}",
    chip: "Releasing",
    chipAbout: "{chip} · about {minutes} min",
    line: "{amount} is leaving zk.money privately to {name}.",
    onItsWay: "{amount} is on its way to {name}.",
    onItsWayGas: "{amount} is on its way to {name}, with {gas} of ETH for gas.",
    passkey: "Confirm with your passkey to start the withdrawal.",
    keepOpen: "Preparing your private withdrawal. Keep this tab open.",
    note: "You can close this. We'll notify you when it arrives.",
  },
  done: {
    coin: "{received} {coin}",
    body: "{amount} reaches {name} on {chain}.",
    bodyGas: "{amount} reaches {name} on {chain}, with {gas} of ETH for gas.",
    note: "You can find it in {activity}.",
    activity: "Activity",
    done: "Done",
  },
  failed: {
    withdrawTitle: "Withdrawal didn't complete",
    swapTitle: "Swap didn't complete",
    failed: "The transaction was not included. Your funds are still in your private balance.",
    bridge:
      "The withdrawal went through, but the bridge to {chain} didn't fill. Your funds are waiting on Ethereum.",
    swap: "The withdrawal went through, but the swap didn't run. Your funds are waiting on Ethereum.",
    failedLine: "The proof expired before it was included · no fee charged",
    bridgeLine:
      "The route expired before it filled · no bridge fee charged. Recover the funds from Activity.",
    swapLine: "Recover the funds from Activity.",
  },
} as const

export default {
  title: "Confirm it's you",
  lead: "Use the passkey you signed in with to approve your new backup.",
  // The passkey that approves, as a row.
  passkey: "Sign-up passkey",
  // The row's detail for a passkey with no name or known manager, as the key list words it.
  unnamed: "Your current passkey",
  pick: "When your browser asks, pick your sign-up passkey, not the new one",
  // The prompt offers only the sign-up passkey, so a wrong pick ends as a closed prompt.
  closed: "The window closed before you approved.",
  confirm: "Confirm with sign-up passkey",
  cancel: "Cancel",
  // Step 2, between the approval's prompt and the payment's.
  ready: {
    title: "Getting ready to pay",
    lead: "Your backup's approved. Next, you pay for it with {approver}. You can close the tab meanwhile.",
    detail: "Getting the payment ready",
    pay: "Pay",
  },
  pay: {
    title: "Pay the network fee",
    lead: "Your backup's approved. Paying adds it to your account, and once paid it can't be cancelled.",
    detail: "Now pay {amount}",
    // Proposed: the account the funding leaves, and its balance.
    from: "Paying from",
    account: "Main Account",
    accountBalance: "Main Account · {balance}",
    // Proposed.
    fee: "Fee",
    // Proposed.
    breakdown: "How the fee adds up",
    // Proposed.
    total: "Total",
    speed: "Speed",
    time: "Time",
    timeValue: "About {minutes} min",
    pay: "Pay {amount}",
  },
} as const

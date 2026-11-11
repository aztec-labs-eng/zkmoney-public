export default {
  lead: "Your backup's saved. Now confirm it with the passkey you signed in with.",
  pick: "When your browser asks, pick your sign-up passkey, not the new one",
  // The prompt offers only the sign-up passkey, so a wrong pick ends as a closed prompt.
  closed:
    "The window closed before you approved. When it opens again, pick your sign-up passkey, not the new one.",
  cancel: "Cancel",
  // Step 2, between the approval's prompt and the payment's.
  ready: {
    title: "Getting ready to pay",
    lead: "Your backup's approved. Next, you pay for it with {approver}. You can close the tab meanwhile.",
    detail: "Approved · getting the payment ready",
    pay: "Pay",
  },
  pay: {
    title: "Pay with {approver}",
    lead: "Your backup's approved. Paying adds it to your account, and once paid it can't be cancelled.",
    detail: "Approved · now pay {amount}",
    cost: "Cost",
    breakdown: "How the cost adds up",
    note: "Paying sends {sent} from your balance, and {back} of it comes back once the backup is added.",
    speed: "Speed",
    time: "Time",
    timeValue: "Up to {minutes} min",
    pay: "Pay {amount}",
  },
  stays: {
    title: "If you cancel",
    body: "The approval you gave stays usable until your account next changes.",
  },
} as const

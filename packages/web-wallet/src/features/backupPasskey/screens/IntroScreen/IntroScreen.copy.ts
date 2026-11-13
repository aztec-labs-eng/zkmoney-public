export default {
  title: "Add a backup passkey",
  lead: "A backup passkey lets you recover your funds if you lose access to your sign-up passkey.",
  back: "Back",
  cost: "Cost",
  costValue: "About {amount}",
  costHint: {
    title: "How the cost adds up",
    fixed: "Service fees, which don't change",
    // Gas, and Faster's tip.
    network: "Network fees, which vary",
    note: "You'll see the exact amount before you pay.",
  },
  time: "Time",
  timeValue: "About {minutes} min",
  next: "What happens next?",
  steps: {
    save: "Save your backup passkey",
    saveWhere: "On the device you pick next",
    saveHere: "With your browser's passkey prompt",
    approve: "Approve with your current passkey",
    approveDetail: "The passkey you signed in with",
    wait: "Wait for confirmation",
    waitDetail: "Feel free to close this tab.",
    waitFor: "About {minutes} min. Feel free to close this tab.",
    finish: "Approve to finish",
    finishDetail: "We'll remind you on Home",
  },
  links: {
    one: "Your open payment link will be cancelled",
    oneDetail: "Its funds move with your balance.",
    many: "Your {count} open payment links will be cancelled",
    manyDetail: "Their funds move with your balance.",
  },
  // Opens the picker.
  choose: "Choose where to save it",
  // Opens the browser's passkey prompt where there is no picker.
  continue: "Continue",
} as const

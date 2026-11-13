export default {
  title: "Approve to finish",
  // The button that asks for the approval, and `finishTitle` the same words as its sheet's
  // title, where the word joiner keeps a balanced title from breaking at "sign-".
  finish: "Finish with sign-up passkey",
  finishTitle: "Finish with sign-\u2060up passkey",
  lead: {
    one: "Almost there. Confirm once more with the passkey you signed up with.",
    count: "Almost there. Confirm {count} more times with the passkey you signed up with.",
    // While the paylinks' approvals are not counted yet.
    several: "Almost there. Confirm a few more times with the passkey you signed up with.",
  },
  closed: "The window closed before you approved. Your backup won't work until you do.",
  paused: {
    lead: "Part of your balance couldn't move. Try again to finish adding your backup.",
    detail: "Paused, try again",
  },
  // Step 4 while the wallet works on its own.
  working: {
    title: "Finishing your backup",
    lead: "Almost there. You can close the tab. We'll keep working on it.",
    detail: "Getting the last step ready",
    linkExpiring: "A paylink is about to expire. Its funds come back to you once it does.",
    // Proposed copy, pending review.
    keepOpen: {
      one: "Keep this open. 1 more approval to go.",
      count: "Keep this open. {count} more approvals to go.",
      several: "Keep this open. A few more approvals to go.",
    },
  },
  // Step 4 as the move's rows. Proposed copy, pending review.
  step: "Step 4 of 4",
  rows: {
    link: "Take back 1 paylink",
    links: "Take back {count} paylinks",
    funds: "Move your funds",
    main: "Main Account",
    savings: "Savings",
    other: "Other balance",
  },
} as const

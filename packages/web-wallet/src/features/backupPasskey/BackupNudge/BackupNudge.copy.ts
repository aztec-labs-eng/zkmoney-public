export default {
  oneKey: {
    title: "Protect your account",
    body: "Add a second passkey on another device so you can always recover your funds.",
  },
  oneDevice: {
    title: "Protect your account",
    body: "Add a second passkey on your phone so you can recover your account if this device is lost.",
  },
  finish: {
    title: "Finish backing up your account",
    body: "To finish backing up, approve the remaining steps.",
    approve: "Approve",
  },
  // Proposed copy, pending review: an add waiting at Approve or Pay.
  resume: {
    title: "Finish backing up your account",
    body: "Your backup passkey is saved. A few more steps to add it to your account.",
    continue: "Continue",
  },
  // Proposed copy, pending review: the network works on the add.
  adding: {
    title: "Adding your backup",
    body: "The network is confirming it.",
    left: "About {minutes} min left. You can close the tab in the meantime.",
    almost: "Almost done.",
    delayed: "This is taking longer than usual. Your funds are safe.",
    view: "View",
  },
  // Proposed copy, pending review.
  moveFunds: {
    title: "Finish moving your funds",
    body: "Some funds are still at your earlier address.",
    continue: "Continue",
  },
  add: "Add a backup passkey",
  notNow: "Not now",
  // Proposed copy, pending review.
  badge: "Your account has no backup passkey",
  // Proposed copy, pending review: Settings' Passkeys row while a saved add is on its tracker.
  finishSetup: "Finish setup",
  // Settings' Passkeys row for any other saved add.
  pending: "Pending",
} as const

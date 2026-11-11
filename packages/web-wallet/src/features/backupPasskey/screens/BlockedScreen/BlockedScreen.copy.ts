export default {
  title: "A few things first",
  lead: "Take care of these first, then come back to add your backup.",
  add: "Add a backup passkey",
  registered: {
    done: { label: "Account registered", detail: "Done" },
    pending: { label: "Finish registering your account", detail: "It isn't registered yet." },
    finishing: { label: "Wait for your registration to finish", detail: "Try again in a moment." },
  },
  savings: { label: "Finish your Savings move", detail: "Wait for it to land.", action: "View" },
  withdrawal: { label: "Finish your withdrawal", detail: "Wait for it to arrive.", action: "View" },
  link: {
    creating: {
      label: "Finish creating your paylink",
      detail: "Wait for it to be ready.",
    },
    token: {
      label: "Cancel your paylinks from before the upgrade",
      detail: "Adding a backup can't take them back for you.",
    },
    cancel: {
      label: "Cancel your open paylink",
      detail: "Adding a backup can't take it back for you.",
    },
    expiry: {
      label: "Wait for your paylink to expire",
      detail: "It expires on {date}.",
    },
    action: "Review",
  },
  migration: {
    label: "Finish your upgrade",
    detail: "Some of your funds are still on your old account.",
    action: "Upgrade",
  },
  balance: { label: "Have at least {need}", detail: "You have {have}.", action: "Deposit" },
  pieces: {
    label: "Combine your balance",
    detail: "It's in too many small pieces. Send yourself {send} first.",
  },
  synced: { label: "Wait for your balance to sync", detail: "Try again in a moment." },
  uses: {
    label: "Wait for more sponsored transactions",
    detail: "Not enough are left this period.",
  },
} as const

export default {
  charged: "Charged",
  nothing: "Nothing",
  // Proposed copy, pending review. The flow reaches these sheets only before any funding lands.
  funding: "Your funding",
  otherPlace: "Choose another place",
  usePhone: "Use my phone instead",
  startOver: "Start over",
  check: "Check my passkeys",
  cleanup: "Quick cleanup",
  closed: {
    title: "The passkey window was closed",
    lead: "No backup was saved and nothing was charged. Try again when you're ready.",
  },
  tooLong: {
    title: "This passkey can't be a backup",
    lead: "Its credential id is longer than the account can store. Cancel and use another passkey.",
  },
  changed: {
    title: "Your passkeys changed on another device",
    lead: "Nothing was charged. Check your passkeys, then start again.",
  },
  failed: {
    title: "We couldn't add your backup",
    lead: "Something went wrong on our side. Nothing was charged. Try again in a moment.",
  },
  mismatch:
    "This passkey's signature doesn't match the key this browser recorded for it. Clear this site's data and sign in again.",
  // Proposed copy, pending review, except `idle`.
  report: {
    idle: "Report a bug",
    sending: "Sending…",
    sent: "Report sent",
    failed: "Couldn't send, try again",
  },
  fees: {
    title: "Network fees are high right now",
    lead: "Ethereum is busy, so a backup costs more than usual. Nothing was charged. Try again a bit later.",
  },
} as const

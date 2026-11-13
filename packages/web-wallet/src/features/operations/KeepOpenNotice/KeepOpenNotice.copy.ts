export default {
  /** The phone card's heading while the page proves. */
  title: "Keep zk.money open",
  /** What runs, e.g. "Sending $24.00 to @ada". */
  doing: "{live} {summary}",
  /** A page the phone suspends stops proving, as a closed one does. */
  phone: "Don't close the app, switch apps or lock your phone until it's sent.",
  /** The phone card's tap: it shrinks to a strip, out of the top bar's way. */
  shrink: "Shrink this notice. The transaction keeps going.",
  /** Once it is sent, beside its summary, e.g. "$24.00 to @ada". */
  sent: "Sent",
  /** The desktop tab's ask, in the wallet's own voice. */
  desktop: "Keep this {place} open, I'm still working on it.",
  /** The browser tab's title, read off the tab strip. */
  tabTitle: {
    keep: "⏳ {live}… keep me open",
    safe: "✓ Sent · zk.money",
  },
} as const

export default {
  diagnosis: {
    unanchored:
      "This passkey is on @{tag}'s account, but its record couldn't be confirmed yet. Try again.",
    notReproducedHere:
      "This passkey is listed for @{tag}, but this attempt didn't open its wallet. Go back, then choose Show passkeys to use your phone or a security key.",
    differentPasskey:
      "This isn't a passkey on @{tag}'s account. Go back and check the tag, or choose Show passkeys to pick one of @{tag}'s passkeys.",
    inconclusive:
      "Couldn't confirm which passkey this is — @{tag}'s account has more keys than we can read. Go back, then choose Show passkeys to use your phone or a security key.",
  },
  network: "Couldn't check this passkey against the network. Try again.",
  reserved:
    "@{tag} is reserved for this passkey, but the signup that claims it never finished, so there is no wallet to open yet. Pick it back up to finish.",
  unanchored:
    "Your passkey reproduces @{tag}'s account, but its record couldn't be confirmed. Try again.",
  keyMismatch:
    "This passkey's key doesn't reproduce @{tag}'s account. Go back and check the tag, or choose Show passkeys and pick your phone (scan the QR code with it) or your security key in the browser's prompt.",
  grantMismatch:
    "This passkey cannot continue @{tag}'s grant. Go back and choose the passkey used to begin signup.",
  notOffered: "The prompt closed without a passkey for zk.money.",
  notOnDevice: "This device was asked for @{tag}'s passkey by name and didn't offer it.",
  tagNotReserved: "Couldn't match that tag — @{tag} is not the tag this passkey reserved.",
  tagUnmatched: "Couldn't match that tag{detail}. Try again.",
  tagUnmatchedDetail: " — {message}",
  finishFailed: "Couldn't finish signing in. Try again.",
  showPasskeys: "Show passkeys",
  typeTag: "Type your @tag",
  continueSignup: "Continue signing up",
  back: "Back",
  otherTag: "Use a different @tag",
  cancel: "Cancel sign-in",
  paymentWaiting: "Your payment is waiting to be claimed.",
  connectWaiting: "Once you're in, you can add the contact someone shared with you.",
  signingInPasskey: "Signing in with passkey…",
  signingIn: "Signing in…",
} as const

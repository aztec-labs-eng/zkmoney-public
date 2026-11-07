export default {
  dismiss: "Dismiss",
  taken: {
    title: "Tag not available",
    body: "@{tag} was claimed by someone else before your registration completed. Your wallet and funds are unaffected — claim a new tag to continue.",
    cta: "Claim a new tag",
  },
  // `failed_terminal` carries no durable reason (exhausted budget and a deterministic rejection
  // close the same phase), so the copy stays true for both causes.
  failed: {
    title: "Registration failed",
    body: "@{tag} couldn't be claimed right now. Your wallet and funds are unaffected — pick another tag, or try this one again later.",
    cta: "Start over",
  },
  recovery: {
    title: "Tag mismatch",
    body: "Your account already claimed a tag other than @{tag}. Enter with your passkey to recover it.",
    cta: "Enter with your passkey",
  },
} as const

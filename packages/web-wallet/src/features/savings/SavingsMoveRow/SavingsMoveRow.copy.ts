export default {
  counterparty: {
    main: { in: "To Savings", out: "From Savings" },
    savings: { in: "From Main Account", out: "To Main Account" },
  },
  // Proposed copy, pending review.
  toVault: "To {vault}",
  fromVault: "From {vault}",
  route: { in: "Main → {vault}", out: "{vault} → Main" },
  savings: "Savings",
  switched: "Switched vault",
  switchRoute: "{from} → {to}",
  stranded: "Needs recovery",
  // Proposed copy for what a delayed move waits on, pending review.
  delay: {
    relayerDropped: "Taking longer than usual",
  },
  noFigure: "—",
  open: "Open move details",
} as const

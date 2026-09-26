---
category: Status & Feedback
---
Tiny liquid-glass capsule identifying a transaction's direction/kind. `kind` covers seven cases: `received` (the only one with a leading icon), `sent`, `deposit`, `withdraw`, `incomingRequest` ("You owe"), `outgoingRequest` ("Owes you"), and `outgoingLink` ("You send"). The three request/link kinds tint gold, the rest stay white on glass.

Place inside chat bubbles, activity detail sheets, and amount cards to tag the leg of a payment. Built on `LiquidGlassPill`; use that primitive directly for non-transaction labels.

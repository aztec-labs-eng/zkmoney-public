---
category: Rows & Lists
---
One transaction in the activity feed. The amount string is signed: a `+` prefix renders green (credit). `statusLabel` drives the little colored badge under the amount (Pending / Unclaimed / You owe / Failed / Cancelled / Replaced / Refunded / Expired). Paylink and bridge rows use `avatarIcon="link"` or `avatarIcon="wallet"` instead of the contact avatar. Rows that need user action (claim, pay, share, cancel) take `actions` — the primary action uses `actionStyle="gradient"`, secondary "neutral".

Stack rows in a plain vertical list with 8px gaps on the dark canvas.

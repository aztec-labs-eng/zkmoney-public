---
category: Status & Feedback
---
Tiny colored capsule that sits under a row amount conveying transaction status. `badgeStyle` picks the color and whether a clock glyph trails the label: `pending` (orange, clock), `awaitingClaim` / `request` (gold, clock), `failed` (pink), `cancelled` / `replaced` (grey). The fill is an extremely subtle 3% wash of the status color; the label carries the color.

Composed automatically by `ActivityListRow` via its `statusLabel` prop, so reach for it directly only in custom row layouts. For headline status use `StatusPill` instead.

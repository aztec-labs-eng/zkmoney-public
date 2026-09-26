---
category: Foundations
---
Base liquid-glass capsule primitive: `[icon] [label]` (icon trails by default; set `iconLeading` to lead) at a 10px label on a near-transparent glass fill. `foreground`, `tint` + `tintOpacity`, and `fallbackFill` recolor it (gold `#EED04E` at 0.18 tint for request states); padding, font sizes, tracking, and shadow are all tunable.

It underpins `TransactionKindChip` and the role chips on amount cards. Prefer those wrappers when one fits, and use this directly for custom micro-labels on glass. Not a status indicator: that's `StatusPill` / `StatusBadge`.

---
category: Status & Feedback
---
Flat status tag: `[icon] label` on a translucent white 4px-radius rect, for prominent state indication on detail sheets and headers (Successful / Unclaimed / You owe / Unverified). Pass `icon` for the leading glyph (omit for a label-only pill) and tint via `iconColor`/`labelColor`: green `#56E79D` for success, gold `#EED04E` for waiting states, pink `#FE708B` for "You owe".

Distinct from `StatusBadge` (tiny capsule under a row amount) and `LiquidGlassPill` (glass capsule, 10px label). Use this when the status is the headline, not a row annotation.

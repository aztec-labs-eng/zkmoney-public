---
category: Rows & Lists
---
One holding in a list, such as a Savings vault: a 40px coin, the asset's symbol over what it earns on the left, and its worth over a `RatePill size="sm"` on the right. `badge` sits beside the title, as `ComingSoonPill size="sm" label="New"` for a holding just added. Every slot takes a node, so a loading row passes `SkeletonBlock`s.

The row is a 70px card of its own (`--surface-faint`, hairline border, `--radius-12`); stack rows 16px apart in a card. Unlike `ListRow`, its title is plain 14px text, not a gradient, and its trailing side holds two lines.

`onClick` makes the row a button that ends in a `RowChevron`.

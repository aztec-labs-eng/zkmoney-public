---
category: Payments
---
Stacked From/To variant of `AmountSourceCard`: a free-form `roleLabel` header ("From:", "To:"), person row, and the `amount` slot with an optional small `amountCaption` beneath it (e.g. a token conversion). `balanceLoading` swaps the balance value for a spinner; `balanceText` is a preformatted string.

Stack a `cornerStyle="top"` card above a `cornerStyle="bottom"` card with a 4px gap for two-party transfer entry. Render the amount as display type (Sen, 32px, semibold, `var(--font-display)`).

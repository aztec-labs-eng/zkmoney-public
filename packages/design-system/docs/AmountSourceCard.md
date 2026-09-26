---
category: Payments
---
Source card for send/request amount screens: a "From:" + balance header row, then avatar + name/handle with the `amount` slot at the trailing edge. Balance is auto-formatted ("$" currency, whole dollars without decimals).

Render the amount as display type (Sen, 32px, semibold, `var(--font-display)`). For stacked From/To pairs or loading/caption states use `TransferAmountCard` instead.

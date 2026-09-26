---
category: Status & Feedback
---
Open-arc pending spinner: an 80% stroke arc with round caps rotating continuously (1.4s `period`). Defaults are deliberately small and muted (`size` 10, secondary-text grey) for inline "Pending" rows and balance refreshes; scale up and tint brand purple `#A000FF` for proving states.

Pair with a short label at 12 to 14px; `Toast kind="progress"` already embeds one. For modal / hero loading use `GradientSpinner`. For whole-block loading use `Shimmer`.

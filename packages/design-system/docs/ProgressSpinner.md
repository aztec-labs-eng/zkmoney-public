---
category: Status & Feedback
---

`Spinner`'s stroke as a determinate ring: a faint track filled clockwise from the top, with
`progress` from 0 to 1. Default 10px in `color` (secondary text) for the syncing pill beside a
balance. Pass `gradient` to fill the done arc with the brand gradient, as the cutover's 130px
upgrade and withdrawal rings do; `color` then paints the track only. Pass `spin` to turn the ring
like `Spinner`, as the step tracker's current step does while it waits.

For an indeterminate wait use `Spinner` or `GradientSpinner`.

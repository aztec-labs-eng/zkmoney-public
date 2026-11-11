---
category: Status & Feedback
---
Loading shimmer wrapper: while `active` (default) one soft light sweeps across every `SkeletonBlock` inside it, in one pass every 2s, and only across the blocks. `active={false}`, like a reduced-motion preference, shows the blocks without the light.

Wrap the frame of the real thing (an activity row's `zkm-activity-row` markup, a balance `Card`) and put `SkeletonBlock`s where its values go, so layout doesn't shift when data arrives. The `Shimmer` clips whatever its content draws past its sides. Nothing between the `Shimmer` and its blocks may be positioned, transformed, filtered or contained, or the light sweeps against that element instead. For a small inline pending indicator use `Spinner` instead.

---
category: Status & Feedback
---
Loading shimmer wrapper: while `active` (default) it dims its children to 35% opacity and sweeps a white highlight band across them every 1.4s; `active={false}` renders children untouched, so the same tree serves both loading and loaded states.

Wrap real content skeletons (a balance `Card`, an `ActivityListRow`) rather than grey boxes, so layout doesn't shift when data arrives. For a small inline pending indicator use `Spinner` instead.

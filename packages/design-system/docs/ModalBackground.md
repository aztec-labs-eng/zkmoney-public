---
category: Backgrounds
---
Full-screen modal host background: `#0B0B0B` with a purple radial blob pinned to the upper-left corner. Every slide-in modal flow (new payment, send amount, contact picker) paints over this instead of the tab aurora, signalling "you're in a task".

Fills its positioned parent (`position: relative` + `overflow: hidden`); modal content goes in `children`. Slightly lighter base than the `#070707` screen backgrounds.

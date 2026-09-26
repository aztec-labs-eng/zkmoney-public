---
category: Sheets & Modals
---
The base bottom-sheet surface: a #212121 panel with 24px corners and a drag-handle capsule overlaid top-center. Use `corners="all"` for floating cards presented over the scrim and `corners="top"` for sheets docked flush to the bottom edge. It supplies chrome only, so give your content its own padding (leave ~32px at the top so text clears the handle).

For confirmation flows, prefer `ConfirmationSheetShell` inside this surface rather than composing raw content.

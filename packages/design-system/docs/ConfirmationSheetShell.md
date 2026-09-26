---
category: Sheets & Modals
---
Chrome for confirmation bottom sheets: drag handle, centered title header, content area, and a primary CTA pinned at the bottom. Compose the content from `ConfirmationSheetSectionLabel`, `ConfirmationSheetPartyCard`, and `ConfirmationSheetDetailRow`; pass a `PrimaryGradientButton` as `primaryAction`. Provide `onClose` to show the glass back button; omit it on sheets the user shouldn't step back from.

Render it on a sheet surface (`SheetSurface` or a `var(--surface-sheet)` panel with 24px corners): the shell itself is transparent.

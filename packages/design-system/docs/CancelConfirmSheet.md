---
category: Sheets & Modals
---
Disclosure sheet shown when the user tries to cancel an in-flight transaction: title, a "Cancelling costs ~fee" line, a flow-specific disclaimer, then a pink destructive confirm button over a dark "Keep waiting" button. `flow` picks the copy: "send" (default), "withdraw", or "paylinkCreate". You supply only the formatted `estimatedFee`.

Present it on a sheet surface (`var(--surface-sheet)`, 24px corners); the component brings its own padding and drag handle.

---
category: Sheets & Modals
---
Body of a guided-flow sheet, one decision per sheet: a hero mark, a title, a lead, the boxes the step needs, then a primary capsule and an optional text button under it. `hero` sets the tone: `key` for a step of the flow, `warning` for a wait or a fix, `error` for a failure, `success` when done. `primary.style: "plain"` gives the gray capsule for a sheet whose only way on is to close it.

The shell is transparent and draws no dialog or close button. In the web wallet it sits inside `Modal variant="create"`, which gives the 500px card, the close button and, on phones, the bottom sheet. Stack boxes as `children` (12px apart): `StepTracker`, `FactBox`, `InfoBox`, `ChoiceCard`s, a `SheetCard` of `ChecklistRow`s or `KeyStatusRow`s, `NextStepsDisclosure`, `SheetLink`.

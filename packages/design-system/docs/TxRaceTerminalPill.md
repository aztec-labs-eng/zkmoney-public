---
category: Status & Feedback
---
Terminal-state banner shown after a user tries to cancel an in-flight transaction — the "race" between the payment and its cancellation. Pick the `variant` matching the outcome: `minedAsReplacement` (cancel won, green), `minedAsOriginal` (payment won, amber, offer "View tx"), `alreadyMinedSkip`, `bothFailed` (pink, offer "View details"), `submitRejected` (network error, offer "Retry"), `nullifierConflict` (checking, blue-grey), `originalExpired`, `stillPending`. `flow` adjusts copy for send / withdraw / paylink creation.

Place directly under the transaction summary on send screens and activity detail sheets.

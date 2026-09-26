import type { PaylinkNoteView, PaylinkParams, PaylinkService } from "@obsidion/sdk"
import { TxLifecycleService } from "../core/services/transactions/TxLifecycleService"

/**
 * The escrow note behind a paylink — the amount and memo the claim row shows. The link's own amount
 * is unsigned text anyone can edit, so it is never displayed; the note is the only source. The
 * claimer's row is written before the scanner sees the claim `Transfer`, so it cannot come from the
 * event. Fail-open: a note read that throws never blocks the claim; the row goes unknown-amount.
 *
 * Await it before the claim dispatches: the claim nullifies this note, and the read registers the
 * escrow in PXE, which collides with the claim's own registration when the two run side by side.
 */
export async function readPaylinkNote(
  service: PaylinkService,
  params: PaylinkParams,
): Promise<PaylinkNoteView | undefined> {
  try {
    return await service.sync_note(params)
  } catch {
    return undefined
  }
}

/**
 * The creator's memo, read off the escrow's funding `Transfer` event, for the claim row. Fail-open:
 * a read that throws never blocks the claim.
 */
export async function readPaylinkMemo(
  service: PaylinkService,
  params: PaylinkParams,
): Promise<string | undefined> {
  try {
    return (await service.readDepositMeta(params))?.memo
  } catch {
    return undefined
  }
}

/**
 * Lands the memo on an already-written claim row once the event read settles. Call it after the
 * claim has dispatched: the read registers the escrow in PXE, and running it beside the claim's own
 * registration collides in the PXE store. Never awaited; a miss leaves the row memo-less.
 */
export function patchClaimRowMemo(
  service: PaylinkService,
  params: PaylinkParams,
  queueId: string,
): void {
  void readPaylinkMemo(service, params).then((memo) => {
    if (memo) void TxLifecycleService.getInstance().patchPaylinkSynthRow(queueId, { memo })
  })
}

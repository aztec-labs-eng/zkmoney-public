import {
  PAYLINK_TERMS_REFUSAL,
  type PaylinkNoteView,
  type PaylinkParams,
  type PaylinkService,
} from "@obsidion/sdk"

/**
 * The escrow note behind a paylink — the amount the claim row shows. The link's own amount
 * is unsigned text anyone can edit, so it is never displayed; the note is the only source. The
 * claimer's row is written before the scanner sees the claim `Transfer`, so it cannot come from the
 * event. Fail-open: a note read that throws never blocks the claim; the row goes unknown-amount.
 * A note other than the one the link was made for is refused, never read as unknown.
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
  } catch (e) {
    if (e instanceof Error && e.message === PAYLINK_TERMS_REFUSAL) throw e
    return undefined
  }
}

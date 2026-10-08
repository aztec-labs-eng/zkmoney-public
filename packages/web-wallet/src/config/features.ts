/**
 * Feature switches read from the build environment. Each defaults to off and is turned on with the
 * string "true", the convention the other VITE_ flags follow.
 */

/**
 * Email-locked paylinks (`VITE_EMAIL_LOCKED_LINKS`). Off by default (QA standup, 2026-09-22): a sender
 * could lock a link to any address with no warning that the claim needs a Google account for exactly
 * that address, and the proof cache mis-reported a good sign-in as a mismatch. Off hides the "Protect
 * payment" option, and `sponsoredPaylink.ts` refuses an email lock at creation and an email link at
 * decode. Before turning it on, move the Google sign-in hand-off in `googleAuth.tsx` off storage:
 * its callback popup would stop at the already-open screen (see that file).
 */
export const emailLockedLinksEnabled = import.meta.env.VITE_EMAIL_LOCKED_LINKS === "true"

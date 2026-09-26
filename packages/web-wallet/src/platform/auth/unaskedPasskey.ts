/**
 * What a recovery throws when its sheet was held to one credential and another answered. Kept apart
 * from the auth service so telemetry can recognise the error without importing it.
 */
export const UNASKED_PASSKEY_MESSAGE =
  "The passkey that answered is not the one this browser asked for"

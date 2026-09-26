/** Session errors the auth service raises; not policy refusals, so the screens route them apart. */

/** No passkey session on this device: not a refusal, the screen re-enters through `/enter`. */
export class NoPasskeySessionError extends Error {
  constructor() {
    super("no passkey session on this device — enter with your passkey first")
    this.name = "NoPasskeySessionError"
  }
}

/**
 * The session changed while a ceremony was open (a commit or sign-out here, a logout or account
 * switch in another tab): the result is dropped, and whoever changed the session owns the tab.
 */
export class SessionChangedError extends Error {
  constructor() {
    super("the session changed while the passkey prompt was open")
    this.name = "SessionChangedError"
  }
}

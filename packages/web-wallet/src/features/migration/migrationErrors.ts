/** An upgrade pass holds the source's lock, so a user flow that must not wait stops here. */
export class SourceBusyError extends Error {
  constructor() {
    super("An upgrade pass holds this source")
    this.name = "SourceBusyError"
  }
}

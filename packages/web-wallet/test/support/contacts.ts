import { createContacts, memoryBackend, openDatabase } from "@obsidion/front-core"

/** A contact book over a database of its own. */
export const testContacts = () =>
  createContacts({ db: openDatabase(memoryBackend()), now: () => Date.now() })

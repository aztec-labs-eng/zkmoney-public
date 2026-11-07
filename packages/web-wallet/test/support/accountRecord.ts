import {
  createAccountRecord,
  memoryBackend,
  openDatabase,
  type AccountState,
} from "@obsidion/front-core"
import { session as current, type Session } from "../../src/session/session"

/** Gives the session an account record over a database of its own, holding `state` when given. */
export async function giveAccountRecord(state?: AccountState, session: Session = current()) {
  const record = createAccountRecord({ db: openDatabase(memoryBackend()) })
  if (state) await record.save(state)
  Object.defineProperty(session, "accountRecord", { configurable: true, value: record })
  return record
}

/** A sign-in's account record over its own database; each save waits on `seen` before it lands. */
export function recordingAccounts(seen: (state: AccountState) => unknown = () => {}) {
  const record = createAccountRecord({ db: openDatabase(memoryBackend()) })
  const save = record.save
  record.save = async (state) => {
    await seen(state)
    return save(state)
  }
  return () => record
}

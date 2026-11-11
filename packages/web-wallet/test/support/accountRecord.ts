import {
  createAccountRecord,
  memoryBackend,
  openDatabase,
  type AccountEvent,
} from "@obsidion/front-core"
import type { Session } from "../../src/session/session"
import { openTestSession } from "./session"

/** Gives the session an account record over a database of its own, after `event` when given. */
export async function giveAccountRecord(
  event?: AccountEvent,
  session: Session = openTestSession(),
) {
  const record = createAccountRecord({ db: openDatabase(memoryBackend()), now: () => Date.now() })
  if (event) await record.apply(event)
  Object.defineProperty(session, "accountRecord", { configurable: true, value: record })
  return record
}

/** A sign-in's account record over its own database; each write waits on `seen` before it lands. */
export function recordingAccounts(seen: (event: AccountEvent) => unknown = () => {}) {
  const record = createAccountRecord({ db: openDatabase(memoryBackend()), now: () => Date.now() })
  const apply = record.apply
  record.apply = async (event) => {
    await seen(event)
    return apply(event)
  }
  return () => record
}

/**
 * Storage migration: the keys older builds kept in a namespace for stores this build deleted (the
 * zkJWT state and proof cache, the issued connects and the pending connect-backs), removed at the
 * namespace's first open. Remove when no supported build older than the one that writes
 * `acct/zkJwtProofs` v2 remains.
 */
import type { Write } from "../engine/database"

const DEAD_KEYS = [
  "@obsidion/zkjwt/state",
  "@obsidion/zkjwt/proof-cache",
  "obsidion_issued_connects",
  "obsidion_pending_connect_backs",
]

/** Stages the removal of every dead key; one already gone changes nothing. */
export function removeDeadKeys(w: Write): void {
  for (const key of DEAD_KEYS) w.remove(key)
}

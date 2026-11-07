import { bestEffort, readIdentity, stageIdentity } from "@obsidion/front-core"
import { reloadPage } from "../platform/storage/walletStorage"
import { activeNamespace, servesAnotherAccount, type Session } from "./session"
import { stillCommitted } from "./stillCommitted"

/**
 * Account stores load once per page. A sign-in that committed another account than the one this
 * page served, even after a sign-out in between, must replace the document before anything is
 * written, or the first write carries that account's records into the new one's storage. The
 * committed session opens the reloaded page from its cached key. The committed account's identity
 * goes first when it names another address than `l2Address`. `own` is the session the sign-in
 * started under.
 */
export function reloadIfSessionSwitched(own: Session, l2Address: string): boolean {
  const cleared = bestEffort(
    "unknown",
    own.database.write(async (w) => {
      const { prefix } = activeNamespace(own.device)
      const identity = await readIdentity(w.scoped(prefix))
      if (identity && identity.address.toLowerCase() !== l2Address.toLowerCase())
        stageIdentity(w, prefix, null)
    }),
  )
  if (
    own.auth.recordsStale() ||
    servesAnotherAccount(own.device) ||
    (own.namespace.id !== null && !stillCommitted(own))
  ) {
    void cleared.then(reloadPage)
    return true
  }
  return false
}

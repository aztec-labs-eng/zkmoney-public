import { bestEffort, readIdentity, stageIdentity } from "@obsidion/front-core"
import { reloadPage } from "../platform/storage/walletStorage"
import { activeNamespace, servesAnotherAccount, type Session } from "./session"
import { stillCommitted } from "./stillCommitted"

/**
 * Account stores load once per page. A sign-in that committed another account than the one this
 * page served, even after a sign-out in between, must replace the document before anything is
 * written, or the first write carries that account's records into the new one's storage. The
 * committed session opens the reloaded page from its cached key. The committed account's identity
 * goes first when it names another address than `l2Address`. `session` is the session the sign-in
 * started under.
 */
export function reloadIfSessionSwitched(
  session: Pick<Session, "database" | "device" | "auth" | "namespace">,
  l2Address: string,
): boolean {
  const cleared = bestEffort(
    "unknown",
    session.database.write(async (w) => {
      const { prefix } = activeNamespace(session.device)
      const identity = await readIdentity(w.scoped(prefix))
      if (identity && identity.address.toLowerCase() !== l2Address.toLowerCase())
        stageIdentity(w, prefix, null)
    }),
  )
  if (
    session.auth.recordsStale() ||
    servesAnotherAccount(session.device) ||
    (session.namespace.id !== null && !stillCommitted(session))
  ) {
    void cleared.then(reloadPage)
    return true
  }
  return false
}

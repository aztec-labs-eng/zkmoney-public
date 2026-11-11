import { WalletError, type Service } from "@obsidion/front-core"
import * as actual from "../../../src/session/session"
import { backupFixture } from "./backup-passkey"
export * from "../../../src/session/session"

// The backup fixture answers every read the key list makes, so nothing uses these values.
const unread = new Proxy(
  {},
  {
    get: (_target, key) => {
      if (key === "then") return undefined
      throw new WalletError("invariant", "A backup capture used a session service")
    },
  },
)

const built = <T>(service: Service<T>): Service<T> =>
  Object.assign(Object.create(service) as Service<T>, { ready: async () => unread as T })

const sessions = new WeakMap<actual.Session, actual.Session>()

/**
 * The session the Passkeys sheet reads its keys with. Under a backup fixture its wallet and
 * contract services answer `ready()`, as the capture already shows them built.
 */
export const useSession: typeof actual.useSession = () => {
  const session = actual.useSession()
  if (!backupFixture()) return session
  let shown = sessions.get(session)
  if (!shown) {
    shown = {
      ...session,
      wallet: built(session.wallet),
      contractService: built(session.contractService),
    }
    sessions.set(session, shown)
  }
  return shown
}

import { WalletError, type Service } from "@obsidion/front-core"
import * as actual from "../../../src/features/backupPasskey/accountKeys"
import { backupFixture } from "./backup-passkey"
export * from "../../../src/features/backupPasskey/accountKeys"

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

/**
 * The Passkeys sheet's key read. Under a backup fixture its wallet and contract services answer
 * `ready()`, as the capture already shows them built.
 */
export const accountKeys: typeof actual.accountKeys = (query, own) => {
  const real = actual.accountKeys(query, own)
  const shown = actual.accountKeys(query, {
    ...own,
    wallet: built(own.wallet),
    contractService: built(own.contractService),
  })
  return (address) => (backupFixture() ? shown : real)(address)
}

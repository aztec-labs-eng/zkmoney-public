import { WalletError, type OxideIdentityDeps } from "@obsidion/front-core"
import * as actual from "../../../src/features/registration/oxideGenerations"
import { backupFixture } from "./backup-passkey"
export * from "../../../src/features/registration/oxideGenerations"

// The backup fixture resolves the identity itself, so nothing reads these.
const unread = new Proxy(
  {},
  {
    get: (_target, key) => {
      if (key === "then") return undefined
      throw new WalletError("invariant", "A backup capture read the identity generations")
    },
  },
) as OxideIdentityDeps

export const loadOxideGenerations: typeof actual.loadOxideGenerations = async (...args) =>
  backupFixture() ? unread : actual.loadOxideGenerations(...args)

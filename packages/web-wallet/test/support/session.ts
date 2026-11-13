import { fixed, memoryStore, type Balances } from "@obsidion/front-core"
import { accountKeys, readKeysOnDone } from "../../src/features/backupPasskey/accountKeys"
import { rotationView } from "../../src/features/backupPasskey/backupRotations"
import { activeNamespace, switchSession, type Session } from "../../src/session/session"
import { pageSessionDeps, type Page } from "../../src/app/sessionDeps"
import { testCore, testPage } from "./page"
import type { WebWalletConfig } from "../../src/config/env"
import type { PrimedReads } from "../../src/app/pageChain"

/** What a screen reads from the session beside its stores; each a fake of the real value. */
export interface SessionValues {
  auth?: unknown
  /** The page's config; the sandbox default otherwise. */
  config?: WebWalletConfig
  /** What the page's reads start from in place of the manifest. */
  primed?: PrimedReads
  wallet?: unknown
  contractService?: unknown
  account?: unknown
  token?: unknown
  teeSigner?: unknown
  savingsLine?: unknown
  moveQuote?: unknown
  moveCommands?: unknown
  balances?: Pick<Balances, "view" | "records">
  /** Main's token row, a store. */
  mainToken?: unknown
  sipaProcessingObserver?: unknown
  sipaAddresses?: unknown
  fundDeposit?: unknown
  sipaKeys?: unknown
  sipaDiscovery?: unknown
  sipaPipeline?: unknown
  accountRecord?: unknown
  contacts?: unknown
  backupRotations?: unknown
  backupNudges?: unknown
  sweepFee?: unknown
  registrationSchedule?: unknown
  receiveCodes?: unknown
  railPending?: unknown
  sponsoredAllowance?: unknown
  fasterOffer?: unknown
  backupAddRelease?: unknown
}

/** Values the session holds as they are, not as services. */
const PLAIN = new Set([
  "auth",
  "balances",
  "mainToken",
  "savingsLine",
  "moveQuote",
  "sipaProcessingObserver",
  "sipaAddresses",
  "fundDeposit",
  "sipaPipeline",
  "accountRecord",
  "contacts",
  "backupRotations",
  "backupNudges",
  "receiveCodes",
  "railPending",
  "sponsoredAllowance",
  "fasterOffer",
  "backupAddRelease",
])

/** Services the session builds once something asks: a value stands as the one each builds. */
const ASKED = new Set(["sipaDiscovery"])

const isService = (value: unknown) => typeof value === "object" && !!value && "ready" in value

/**
 * A test page, `over` in place, whose `switchTo` opens real sessions. `testPage` stubs it, so it
 * imports no app graph.
 */
export function sessionPage(auth?: unknown, over: Partial<Page> = {}, primed?: PrimedReads): Page {
  const page: Page = {
    ...testPage(auth, over.config, primed),
    ...over,
    switchTo: (namespace, handoff) => switchSession(namespace, pageSessionDeps(page), handoff),
  }
  return page
}

/**
 * Makes the committed namespace's real session current, with each given value in place of its
 * service, ready from the start; a service given stands as it is. A value left out keeps the
 * session's own service.
 */
export function openTestSession(values: SessionValues = {}): Session {
  const page = sessionPage(values.auth, values.config && { config: values.config }, values.primed)
  const session = page.switchTo(activeNamespace(testCore().device))
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined || name === "config" || name === "primed") continue
    Object.defineProperty(session, name, {
      configurable: true,
      value:
        PLAIN.has(name) || isService(value)
          ? value
          : ASKED.has(name)
          ? () => fixed(name, value)
          : fixed(name, value),
    })
  }
  // A wallet given as a value names the page's rollup, as the built wallet does.
  const networkId = (values.wallet as { networkId?: unknown } | undefined)?.networkId
  if (typeof networkId === "string")
    Object.defineProperty(session, "page", {
      configurable: true,
      value: { ...session.page, networkId: memoryStore(networkId).readonly },
    })
  // The session's own read sees its own services, not the values given here.
  const keys = accountKeys(session.page.query, session)
  Object.defineProperty(session, "accountKeys", { configurable: true, value: keys })
  readKeysOnDone(keys, rotationView(session), session.identity)
  return session
}

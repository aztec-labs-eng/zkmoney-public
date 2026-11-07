import { fixed, type Balances } from "@obsidion/front-core"
import { activeNamespace, switchSession, type Session } from "../../src/session/session"
import { pageSessionDeps } from "../../src/app/sessionDeps"
import { testCore, testPage } from "./page"

/** What a screen reads from the session beside its stores; each a fake of the real value. */
export interface SessionValues {
  auth?: unknown
  wallet?: unknown
  contractService?: unknown
  account?: unknown
  token?: unknown
  teeSigner?: unknown
  savings?: unknown
  balances?: Pick<Balances, "view" | "records">
  sipaProcessingObserver?: unknown
  sipaAddresses?: unknown
  fundDeposit?: unknown
  sipaKeys?: unknown
  sipaDiscovery?: unknown
  sipaPipeline?: unknown
  accountRecord?: unknown
  sweepFee?: unknown
  registrationSchedule?: unknown
}

/** Values the session holds as they are, not as resources. */
const PLAIN = new Set([
  "auth",
  "balances",
  "sipaProcessingObserver",
  "sipaAddresses",
  "fundDeposit",
  "sipaPipeline",
  "accountRecord",
])

const isResource = (value: unknown) => typeof value === "object" && !!value && "demand" in value

/**
 * Makes the committed namespace's real session current, with each given value in place of its
 * resource, ready from the start; a resource given stands as it is. A value left out keeps the
 * session's own resource.
 */
export function openTestSession(values: SessionValues = {}): Session {
  const session = switchSession(
    activeNamespace(testCore().device),
    pageSessionDeps(testPage(values.auth)),
  )
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) continue
    Object.defineProperty(session, name, {
      configurable: true,
      value: PLAIN.has(name) || isResource(value) ? value : fixed(name, value),
    })
  }
  return session
}

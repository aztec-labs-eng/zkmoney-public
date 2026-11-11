/** The past-user modal: the old wallet's address, its lookup, the connect intent and the free claim. */
import type { Hex } from "viem"
import type { Config } from "wagmi"
import { getAccount, watchAccount } from "wagmi/actions"
import { derived, lookup, memoryStore, valueOf } from "@obsidion/front-core"
import { fireOnboardingEvent } from "../../lib/analytics"
import type { Session } from "../../session/session"
import { chooseOwnName, type ChosenNameClaim } from "./chooseOwnName"
import { ADDRESS_RE, type LookupState } from "./PastUserAddressInput/PastUserAddressInput"
import { lookupPastUser } from "./pastUserProver"

/** Text that can still become an address as the user types. */
const ADDRESS_PREFIX_RE = /^0(x[0-9a-fA-F]{0,40})?$/

export interface VerifyDeps {
  session: Session
  /** The page's L1 wallet connection. */
  wagmi: Config
  claim: ChosenNameClaim
  /** Whether an address is on the past-user list; tests stand in for the worker. */
  lookup?: (address: Hex) => Promise<boolean>
}

/** The modal's latest render. */
export interface VerifyInputs {
  /** Opens the wallet's connect picker. */
  connect(): Promise<void>
}

export function openVerifyPastUserFlow(deps: VerifyDeps, latest: () => VerifyInputs) {
  const { session, wagmi } = deps
  const isPastUser = deps.lookup ?? ((a: Hex) => lookupPastUser(session.page.config, a))
  const { pastUser } = session
  const account = () => (session.account ? valueOf(session.account) : undefined)
  const owner = () => account()?.getAddress().toString()
  const address = memoryStore<string>(pastUser.current(owner()).account ?? "")
  /** Off between a start's abort and the next start: no lookup runs for a closed modal. */
  const active = memoryStore(false)
  const pastUsers = session.page.query<[Hex], boolean>("pastUserLookup", {
    load: (old) => isPastUser(old),
    stale: 0,
  })
  const answer = lookup(
    derived([address, active], (a, on) => (on && ADDRESS_RE.test(a) ? (a as Hex) : undefined)),
    pastUsers,
    { delayMs: 350 },
  )
  const progress = memoryStore<{ claiming: boolean; error?: unknown }>({ claiming: false })
  const view = derived([address, answer, progress], (a, found, p) => {
    const state: LookupState = !ADDRESS_RE.test(a)
      ? { kind: a && !ADDRESS_PREFIX_RE.test(a) ? "invalid" : "idle" }
      : found.status === "answered"
      ? { kind: found.value ? "found" : "not-found" }
      : { kind: found.status === "failed" ? "error" : "loading" }
    return { address: a, lookup: state, ...p }
  })
  /** What to do once a wallet connects: fill the address, or go on to sign. */
  let pending: "fill" | "sign" | null = null

  const same = (other: string) => other.toLowerCase() === address.get().toLowerCase()
  const check = (old: Hex) => void pastUser.check(old, account())
  const connecting = (next: "fill" | "sign") => {
    pending = next
    void latest().connect()
  }

  return {
    view,
    type: (text: string) => address.set(text),
    retry: () => answer.retry(),
    connectWallet() {
      const connected = getAccount(wagmi).address
      if (connected) address.set(connected)
      else connecting("fill")
    },
    sign() {
      const connected = getAccount(wagmi).address
      if (connected && same(connected)) check(connected)
      else connecting("sign")
    },
    /** A verified past user's free claim of the paid tag waiting on activation. */
    async claimTag(tag: string) {
      const obsidionAccount = account()
      const wallet = valueOf(session.wallet)
      if (!obsidionAccount || !wallet || progress.get().claiming) return
      progress.set({ claiming: true })
      try {
        const over = deps.claim(session, wallet, true, "past_user")
        await chooseOwnName(session, tag, obsidionAccount, over)
        fireOnboardingEvent("name_route_chosen", { route: "past_user" })
        pastUser.setOpen(false)
      } catch (error) {
        progress.set({ claiming: false, error })
      }
    },
    start(signal: AbortSignal) {
      active.set(true)
      const off = answer.subscribe(() => {})
      // A different wallet connected: its address replaces the typed one and is checked first.
      const unwatch = watchAccount(wagmi, {
        onChange({ address: connected }, before) {
          const next = pending
          if (!connected || connected === before.address || !next) return
          pending = null
          if (next === "sign" && same(connected)) check(connected)
          else address.set(connected)
        },
      })
      signal.addEventListener("abort", () => (unwatch(), off(), active.set(false)))
    },
  }
}

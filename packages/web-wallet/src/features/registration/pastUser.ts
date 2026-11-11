import { useMemo } from "react"
import type { Hex } from "viem"
import type { Config } from "wagmi"
import { memoryStore, useStore, NO_SERVICE, serviceStatus } from "@obsidion/front-core"
import { bestEffortSync, type ErrorCode } from "@obsidion/core/errors"
import type { ObsidionAccount } from "@obsidion/sdk"
import type { TabKey, tabStash } from "../../platform/storage/tabStash"
import type { WebWalletConfig } from "../../config/env"
import { collectOnboardingKeys } from "../../session/account"
import { isWalletRejection } from "../../session/l1Wallet"
import type { WebAlphaAuthService } from "../../platform/auth/WebAlphaAuthService"
import { useSession } from "../../session/session"
import {
  claimPastUser,
  PastUserAlreadyUsedError,
  provePastUserForGrant,
  type PastUserProof,
} from "./pastUserClaim"
import { NotPastUserError, provePastUser, signPastUserMessage } from "./pastUserProver"
import { accountServiceFor } from "./registrationDeps"
import { readStash } from "./signupStash"

/** `not_found` and `claimed` end a check that cannot pass with this wallet. */
export type PastUserStep = "connect" | "sign" | "check" | "confirmed" | "not_found" | "claimed"

export interface PastUserState {
  step: PastUserStep
  account?: Hex
  error?: ErrorCode
}

export type PastUserEvent =
  | { type: "connected"; account: Hex }
  | { type: "signed" }
  | { type: "confirmed" }
  | { type: "failed"; error: ErrorCode }
  | { type: "ended"; step: "not_found" | "claimed" }
  | { type: "reset" }

const FOLLOWS = { signed: ["sign", "check"], confirmed: ["check", "confirmed"] } as const

/** Each step moves only from the one before it; a connected wallet starts over at signing. */
export function pastUserReducer(state: PastUserState, event: PastUserEvent): PastUserState {
  switch (event.type) {
    case "connected":
      return { step: "sign", account: event.account }
    case "failed":
      return { ...state, error: event.error }
    case "ended":
      return { step: event.step, account: state.account }
    case "reset":
      return { step: "connect" }
    default: {
      const [from, to] = FOLLOWS[event.type]
      return state.step === from && !state.error ? { ...state, step: to } : state
    }
  }
}

/**
 * A past user verified before any passkey: the old wallet and its owner-less proof, kept for the tab
 * until a grant spends it. `tag` is the tag the grant went to.
 */
export interface PastUserVerified extends PastUserProof {
  account: Hex
  tag?: string
}

const VERIFIED_KEY = "zkm.pastUserVerified"
const checkKey = (owner: string): TabKey => `zkm.pastUserCheck.${owner}`

/**
 * The page's past-user check: one at a time, so closing its modal leaves it running and its result
 * reopens the modal. A passed check is kept for the tab, per account; before one, the owner-less
 * proof waits for a tag.
 */
export function createPastUser(
  stash: typeof tabStash,
  wagmi: Config,
  auth: WebAlphaAuthService,
  config: WebWalletConfig,
) {
  const state = memoryStore({
    check: undefined as (PastUserState & { owner?: string }) | undefined,
    running: false,
    open: false,
    verified: readStash<PastUserVerified>(stash, VERIFIED_KEY, JSON.parse),
  })
  const patch = (next: Partial<ReturnType<typeof state.get>>) =>
    state.set({ ...state.get(), ...next })
  // Without tab storage the page keeps the check.
  const tryStash = (write: () => void) => bestEffortSync(write, undefined)
  /** `owner`'s check as the tab remembers it: only a passed one survives a reload. */
  const recall = (owner: string | undefined): PastUserState => {
    const saved = owner
      ? readStash<PastUserState>(stash, checkKey(owner), JSON.parse)
      : state.get().verified
    return saved && (!owner || (saved as PastUserState).step === "confirmed")
      ? { step: "confirmed", account: saved.account }
      : { step: "connect" }
  }
  /** The check `owner` sees: the running one, else its own. */
  const current = (owner: string | undefined, recalled = recall(owner)): PastUserState => {
    const { check, running } = state.get()
    return check && (running || check.owner === owner) ? check : recalled
  }
  const dispatch = (owner: string | undefined, event: PastUserEvent) => {
    const check = { owner, ...pastUserReducer(current(owner), event) }
    patch({ check })
    if (owner && check.step === "confirmed")
      tryStash(() => stash.set(checkKey(owner), JSON.stringify(check)))
  }
  const setVerified = (verified: PastUserVerified | undefined) => {
    patch({ verified })
    tryStash(() =>
      verified ? stash.set(VERIFIED_KEY, JSON.stringify(verified)) : stash.remove(VERIFIED_KEY),
    )
  }
  return {
    state: state.readonly,
    recall,
    current,
    setOpen: (open: boolean) => patch({ open }),
    setVerified,
    /** "Used zk.money before": the old wallet signs, this browser proves. */
    async check(account: Hex, obsidionAccount: ObsidionAccount | undefined) {
      const owner = obsidionAccount?.getAddress().toString()
      patch({ running: true })
      dispatch(owner, { type: "connected", account })
      try {
        const signature = await signPastUserMessage(wagmi, account)
        dispatch(owner, { type: "signed" })
        if (obsidionAccount) {
          const keys = await collectOnboardingKeys({ auth }, obsidionAccount)
          await claimPastUser(signature, {
            keys,
            accountService: accountServiceFor(config, keys),
            prove: (req) => provePastUser(config, req),
          })
        } else setVerified({ account, ...(await provePastUserForGrant(config, signature)) })
        dispatch(owner, { type: "confirmed" })
      } catch (err) {
        if (err instanceof NotPastUserError) dispatch(owner, { type: "ended", step: "not_found" })
        else if (err instanceof PastUserAlreadyUsedError)
          dispatch(owner, { type: "ended", step: "claimed" })
        else
          dispatch(owner, {
            type: "failed",
            error: isWalletRejection(err) ? "pastUser.unsigned" : "pastUser.unchecked",
          })
      } finally {
        patch({ running: false, open: true })
      }
    },
    /** Starts over unless a check is running or has passed. */
    reset(owner: string | undefined) {
      if (!state.get().running && current(owner).step !== "confirmed")
        dispatch(owner, { type: "reset" })
    },
    /** A grant refused the owner-less proof as spent: the check ends as claimed and says so. */
    claimedAtGrant() {
      setVerified(undefined)
      dispatch(undefined, { type: "ended", step: "claimed" })
      patch({ open: true })
    },
  }
}

export type PastUser = ReturnType<typeof createPastUser>

/** The page's check as the signed-in account sees it. */
export function usePastUserCheck() {
  const { pastUser, identity, account } = useSession()
  const unlocked = useStore(account ?? NO_SERVICE, serviceStatus) === "ready"
  const address = useStore(identity, (i) => i.value?.address)
  const owner = unlocked ? address : undefined
  const recalled = useMemo(() => pastUser.recall(owner), [pastUser, owner])
  const state = useStore(pastUser.state, () => pastUser.current(owner, recalled))
  return { state, owner }
}

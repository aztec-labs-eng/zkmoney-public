/**
 * Whether the signed-in account may start an action now, and why not. One policy for the action
 * routes and the presses that start an action: a name first, then the tag claim, then the upgrade,
 * then the sponsored rail. A deposit stays open to the registration that owes it. A frozen portal,
 * or a frozen build past its freeze time, closes every action except the withdrawal, which becomes
 * its refund exit.
 */
import { useCallback, useEffect, useRef } from "react"
import { isDemoMode } from "../dev/demoFlag"
import { showErrorModal } from "../errors/errorModal"
import { useUpgradeLock } from "./migration/upgradeLock"
import { loadWalletIdentity } from "./identity/walletIdentity"
import {
  openMigrationDialog,
  useUpgradeStatus,
  type UpgradeState,
} from "./migration/migrationDialog"
import { useNameClaimPending, useRegistrationDepositOwed } from "./onboarding/openRegistration"
import { useSponsoredRailPending } from "./onboarding/sponsoredRailReadiness"
import { usePortalFrozen } from "./withdraw/portalFrozen"
import { FREEZES, isFrozen } from "../upgradeFreeze"

export type WalletAction =
  | "send"
  | "receive"
  | "deposit"
  | "withdraw"
  | "link"
  | "savings"
  | "claim"

/**
 * - `name`: the account needs a name first.
 * - `home`: the tag claim is still landing; Home shows how far it is.
 * - `upgrade`: the account must upgrade first.
 * - `holding`: whether it must upgrade is not known yet.
 * - `checking`: whether the sponsored rail carries the account is not known yet.
 * - `registering`: the account's registration has yet to reach the rollup.
 * - `frozen`: the wallet is frozen (`ActionState.frozen`), so the action is closed.
 * - `exit`: the wallet is frozen, so a withdrawal refunds everything to L1.
 */
export type ActionVerdict =
  | "open"
  | "name"
  | "home"
  | "upgrade"
  | "holding"
  | "checking"
  | "registering"
  | "frozen"
  | "exit"

export interface ActionState {
  /** No identity reads as named. */
  named: boolean
  claimPending: boolean
  depositOwed: boolean
  railPending: boolean | undefined
  upgrade: UpgradeState
  /** The account's upgrade lock is released: it is current on this version. */
  current: boolean
  /** The account's upgrade lock is held: an upgrade it started is not done. */
  locked: boolean
  /** This page has read the account's upgrade runs, so the lock can be trusted. */
  lockChecked: boolean
  demo: boolean
  /** `useWalletFrozen`. */
  frozen: boolean
}

/** What each action needs besides the upgrade. */
const NEEDS: Record<WalletAction, { name?: true; claim?: true; rail?: true }> = {
  send: { name: true, claim: true, rail: true },
  withdraw: { name: true, claim: true, rail: true },
  link: { name: true, claim: true, rail: true },
  deposit: { name: true, claim: true },
  receive: { claim: true },
  savings: {},
  claim: {},
}

export function actionVerdict(action: WalletAction, s: ActionState): ActionVerdict {
  if (s.frozen) return action === "withdraw" ? "exit" : "frozen"
  const needs = NEEDS[action]
  if (needs.name && !s.named) return "name"
  if (action === "deposit" && s.depositOwed) return "open"
  if (needs.claim && s.claimPending) return "home"
  const upgrade = s.demo ? undefined : upgradeVerdict(s)
  if (upgrade) return upgrade
  if (!needs.rail || s.demo) return "open"
  if (s.railPending === undefined) return "checking"
  return s.railPending ? "registering" : "open"
}

/** A held lock waits for its upgrade; an account current here waits only on one it is known to need. */
export function upgradeVerdict({
  upgrade,
  current,
  locked,
  lockChecked,
}: Pick<ActionState, "upgrade" | "current" | "locked" | "lockChecked">):
  | "upgrade"
  | "holding"
  | undefined {
  if (locked) return "upgrade"
  if (!lockChecked) return "holding"
  switch (upgrade) {
    case "offered":
    case "running":
    case "stopped":
      return "upgrade"
    case "finishing":
    case "failed":
      return current ? undefined : "upgrade"
    case "checking":
      return current ? undefined : "holding"
    case "none":
      return undefined
  }
}

/** The deployment's portal is frozen, or this build is past its freeze time. */
export function useWalletFrozen(): boolean {
  return usePortalFrozen() || (FREEZES && isFrozen())
}

export function useActionState(): ActionState {
  const identity = loadWalletIdentity()
  const lock = useUpgradeLock(identity?.address)
  return {
    named: !identity || !!identity.handle,
    claimPending: useNameClaimPending(),
    depositOwed: useRegistrationDepositOwed(),
    railPending: useSponsoredRailPending(),
    upgrade: useUpgradeStatus().state,
    current: lock.state === "released",
    locked: lock.state === "held",
    lockChecked: lock.checked,
    demo: isDemoMode(),
    frozen: useWalletFrozen(),
  }
}

export function useActionVerdict(action: WalletAction): ActionVerdict {
  return actionVerdict(action, useActionState())
}

export const FROZEN_COPY = {
  title: "zk.money is down for its upgrade",
  message: "Your funds are safe. You can still withdraw with your own wallet.",
}

/**
 * Starts an action from a press. An upgrade the account must make opens first, titled for the
 * action; while that is not known the sheet holds the action and starts it if no upgrade is needed,
 * unless the screen that pressed it is gone. Anything else the action's own route answers.
 */
export function useActionGuard(): (action: WalletAction, run: () => void) => void {
  const state = useRef<ActionState>(undefined as never)
  state.current = useActionState()
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  return useCallback((action, run) => {
    const verdict = actionVerdict(action, state.current)
    if (verdict === "frozen") showErrorModal(FROZEN_COPY)
    else if (verdict === "upgrade") openMigrationDialog({ action })
    else if (verdict === "holding")
      openMigrationDialog({ action, then: () => mounted.current && run() })
    else run()
  }, [])
}

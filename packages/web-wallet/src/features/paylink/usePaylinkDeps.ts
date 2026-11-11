import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { NO_SERVICE, serviceStatus, useStore, type WithdrawalRecord } from "@obsidion/front-core"
import { useWithdrawals } from "../withdraw/useWithdrawals"
import { linkWithdrawalIdentity, linkVoucherUses, type PaylinkExitDeps } from "./paylinkExit"
import type { SponsoredPaylinkDeps } from "./sponsoredPaylink"
import type { PaymentLink } from "./types"
import { useSession } from "../../session/session"

/** The paylink deps once the PXE, contracts and enclave are up, before an account signs. */
export type PaylinkKit = Omit<SponsoredPaylinkDeps, "account">

/**
 * Everything a sponsored paylink call needs except the signing account — live on the visitor
 * page, where the PXE is up but the passkey has not been reused yet.
 */
export function usePaylinkKit(): PaylinkKit | undefined {
  const session = useSession()
  const rollupAddress = useStore(session.page.networkId)
  const token = useStore(session.token ?? NO_SERVICE, serviceStatus)
  const teeSigner = useStore(session.teeSigner, serviceStatus)
  const contracts = useStore(session.contractService, serviceStatus)
  const ready =
    !!rollupAddress && token === "ready" && teeSigner === "ready" && contracts === "ready"
  // A rebuilt service passes through loading, so whatever read the deps reads again.
  return useMemo(
    () => (ready ? { rollupAddress, session } : undefined),
    [ready, rollupAddress, session],
  )
}

/**
 * Everything a sponsored paylink call needs, or undefined until all contexts are live —
 * `rollupAddress` hydrates one node call after the wallet, so the gate covers both.
 */
export function usePaylinkDeps(): SponsoredPaylinkDeps | undefined {
  const kit = usePaylinkKit()
  const unlocked = useStore(useSession().account ?? NO_SERVICE, serviceStatus) === "ready"
  return useMemo(() => (kit && unlocked ? { ...kit } : undefined), [kit, unlocked])
}

/**
 * What a bearer cash-out needs: the PXE-backed wallet, the contracts, and the enclave co-signer —
 * no account, since the whole point is a holder who has none. Undefined until the enclave connects.
 */
export function useLinkExitDeps(): PaylinkExitDeps | undefined {
  const session = useSession()
  const rollupAddress = useStore(session.page.networkId)
  const teeSigner = useStore(session.teeSigner, serviceStatus)
  const contracts = useStore(session.contractService, serviceStatus)
  const ready = !!rollupAddress && teeSigner === "ready" && contracts === "ready"
  return useMemo(
    () => (ready ? { rollupAddress, session } : undefined),
    [ready, rollupAddress, session],
  )
}

/**
 * Deadline for checking withdrawal funding. A timeout is unknown, never an empty voucher.
 */
const VOUCHER_ANSWER_MS = 12_000

/**
 * Whether this link can be cashed out to Ethereum, answered by the chain: an unclaimed link
 * whose escrow still holds a voucher. `uses` is undefined while the read is in flight and 0 when
 * the link carries none, so the caller can hold the choice back rather than offer one that fails.
 */
export function useLinkVoucher(
  link: PaymentLink | null | undefined,
  /** `enabled: false` holds the read (answer stays unknown): for a caller whose own read of the
   *  escrow is still running, which a fresh escrow's note must land for first. */
  { enabled = true }: { enabled?: boolean } = {},
): {
  uses: number | undefined
  deps: PaylinkExitDeps | undefined
  error: string | undefined
  retry: () => void
} {
  const deps = useLinkExitDeps()
  const session = useSession()
  // Checking funding requires neither an account nor the signer used for the eventual burn.
  const walletBuilt = useStore(session.wallet, serviceStatus) === "ready"
  const contracts = useStore(session.contractService, serviceStatus) === "ready"
  const [uses, setUses] = useState<number>()
  const [error, setError] = useState<string>()
  const [attempt, setAttempt] = useState(0)
  const retry = useCallback(() => setAttempt((n) => n + 1), [])
  const eligible = !!link && link.status === "unclaimed"
  const fragment = link?.fragment
  // The token the page's own read found, so the voucher read skips its own read of the note.
  const token = useRef(link?.tokenAddress)
  token.current = link?.tokenAddress
  // eslint-disable-next-line local/effect-hook -- debt
  useEffect(() => {
    setUses(undefined)
    setError(undefined)
    if (!eligible || !enabled || !fragment) return
    let stale = false
    const fail = () => {
      if (stale) return
      stale = true
      setError("We couldn't check Ethereum withdrawal availability. Please try again.")
    }
    // The deadline bounds the chain read, not the wallet boot that precedes it.
    if (!walletBuilt || !contracts) return
    // eslint-disable-next-line local/timer-in-view -- debt
    const timer = setTimeout(fail, VOUCHER_ANSWER_MS)
    void linkVoucherUses(session, fragment, token.current).then(
      (n) => {
        if (stale) return
        clearTimeout(timer)
        setUses(n)
      },
      () => {
        clearTimeout(timer)
        fail()
      },
    )
    return () => {
      stale = true
      clearTimeout(timer)
    }
  }, [eligible, enabled, walletBuilt, contracts, session, fragment, attempt])
  return { uses: eligible ? uses : 0, deps, error: eligible ? error : undefined, retry }
}

/**
 * This browser's own cash-out of this link, if it made one. A spent escrow reads as claimed on
 * chain, so without this the holder who just withdrew would be told someone else took the money.
 * Mounting also resumes the chain watcher, so a reopened link keeps advancing its withdrawal.
 *
 * A `failed` record is not one: the cash-out throws only pre-mine, so the escrow still holds the
 * funds and the link can be cashed out again. Reporting it would tell the holder they withdrew and
 * take away the retry, with the money still sitting there. Nor is a registration burn: the link
 * paid for this wallet's own account, and the signup that started it is still on screen.
 */
export function useLinkWithdrawal(
  link: PaymentLink | null | undefined,
): WithdrawalRecord | undefined {
  const { records } = useWithdrawals()
  const fragment = link?.fragment
  const identity = useMemo(() => {
    if (!fragment) return undefined
    try {
      return linkWithdrawalIdentity(fragment)
    } catch {
      return undefined
    }
  }, [fragment])
  return useMemo(
    () =>
      identity
        ? records.find(
            (r) =>
              r.phase !== "failed" && r.intent !== "registration" && r.paylinkId === identity.id,
          )
        : undefined,
    [records, identity],
  )
}

import { useCallback, useEffect, useMemo, useState } from "react"
import {
  useAccountContext,
  useAssetContext,
  useAztecContext,
  useContractServiceContext,
  type WithdrawalRecord,
} from "@obsidion/front-core"
import { useWithdrawals } from "../withdraw/useWithdrawals"
import { linkWithdrawalIdentity, linkVoucherUses, type PaylinkExitDeps } from "./paylinkExit"
import type { SponsoredPaylinkDeps } from "./sponsoredPaylink"
import type { PaymentLink } from "./types"

/** PXE + contracts + enclave, before an account exists to sign with. */
export type PaylinkKit = Omit<SponsoredPaylinkDeps, "account">

/**
 * Everything a sponsored paylink call needs except the signing account — live on the visitor
 * page, where the PXE is up but the passkey has not been reused yet.
 */
export function usePaylinkKit(): PaylinkKit | undefined {
  const { obsidionWallet, rollupAddress } = useAztecContext()
  const { tokenService, teeSigner } = useAssetContext()
  const { contractService } = useContractServiceContext()
  return useMemo(
    () =>
      obsidionWallet && tokenService && teeSigner && contractService && rollupAddress
        ? { wallet: obsidionWallet, tokenService, contractService, teeSigner, rollupAddress }
        : undefined,
    [obsidionWallet, tokenService, teeSigner, contractService, rollupAddress],
  )
}

/**
 * Everything a sponsored paylink call needs, or undefined until all contexts are live —
 * `rollupAddress` hydrates one node call after the wallet, so the gate covers both.
 */
export function usePaylinkDeps(): SponsoredPaylinkDeps | undefined {
  const kit = usePaylinkKit()
  const { obsidionAccount } = useAccountContext()
  return useMemo(
    () => (kit && obsidionAccount ? { ...kit, account: obsidionAccount } : undefined),
    [kit, obsidionAccount],
  )
}

/**
 * What a bearer cash-out needs: the PXE-backed wallet, the contracts, and the enclave co-signer —
 * no account, since the whole point is a holder who has none. Undefined until the enclave connects.
 */
export function useLinkExitDeps(): PaylinkExitDeps | undefined {
  const { obsidionWallet } = useAztecContext()
  const { teeSigner } = useAssetContext()
  const { contractService } = useContractServiceContext()
  return useMemo(
    () =>
      obsidionWallet && teeSigner && contractService
        ? { wallet: obsidionWallet, contractService, teeSigner }
        : undefined,
    [obsidionWallet, teeSigner, contractService],
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
  /** `enabled: false` holds the read (answer stays unknown) — for a caller that has another PXE
   *  registration of the same escrow in flight. */
  { enabled = true }: { enabled?: boolean } = {},
): {
  uses: number | undefined
  deps: PaylinkExitDeps | undefined
  error: string | undefined
  retry: () => void
} {
  const deps = useLinkExitDeps()
  const { obsidionWallet } = useAztecContext()
  const { contractService } = useContractServiceContext()
  // Checking funding requires neither an account nor the signer used for the eventual burn.
  const readDeps = useMemo(
    () =>
      obsidionWallet && contractService ? { wallet: obsidionWallet, contractService } : undefined,
    [obsidionWallet, contractService],
  )
  const [uses, setUses] = useState<number>()
  const [error, setError] = useState<string>()
  const [attempt, setAttempt] = useState(0)
  const retry = useCallback(() => setAttempt((n) => n + 1), [])
  const eligible = !!link && link.status === "unclaimed"
  const fragment = link?.fragment
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
    if (!readDeps) return
    const timer = setTimeout(fail, VOUCHER_ANSWER_MS)
    void linkVoucherUses(readDeps, fragment).then(
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
  }, [eligible, enabled, readDeps, fragment, attempt])
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

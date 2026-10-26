import { useEffect, useState } from "react"
import type { Address } from "viem"
import { readL1DepositTokenBalance, type L1TokenBalance } from "./l1DepositTokenBalance"

export type { L1TokenBalance }

/** Funds can arrive from another tab or app, such as a faucet mint, while the form is open. */
export const L1_BALANCE_REFRESH_MS = 15_000

/**
 * The connected wallet's L1 balance of `token` (default: the manifest token). It is read again
 * while open and whenever the page regains focus. The receive form uses it as the amount ceiling.
 */
export function useL1TokenBalance(opts: {
  account: Address | null
  wrongChain: boolean
  token?: Address
}): L1TokenBalance | undefined {
  const { account, wrongChain, token } = opts
  const [balance, setBalance] = useState<L1TokenBalance>()

  useEffect(() => {
    setBalance(undefined)
    if (!account || wrongChain) return
    let live = true
    // Only the newest read lands, so a slow older one cannot undo it.
    let latest = 0
    const read = () => {
      const id = ++latest
      return (
        readL1DepositTokenBalance(account, token)
          .then((next) => {
            // A new object on every read, so it clears any shortfall a rejected transfer reported.
            if (live && id === latest) setBalance(next)
          })
          // A failed refresh keeps the last balance read.
          .catch(() => {})
      )
    }
    const onVisible = () => {
      if (document.visibilityState === "visible") void read()
    }
    void read()
    const timer = setInterval(() => void read(), L1_BALANCE_REFRESH_MS)
    window.addEventListener("focus", read)
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      live = false
      clearInterval(timer)
      window.removeEventListener("focus", read)
      document.removeEventListener("visibilitychange", onVisible)
    }
  }, [account, wrongChain, token])

  return balance
}

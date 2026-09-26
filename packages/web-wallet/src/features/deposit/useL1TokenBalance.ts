import { useEffect, useState } from "react"
import type { Address } from "viem"
import { readL1DepositTokenBalance, type L1TokenBalance } from "./l1DepositTokenBalance"

export type { L1TokenBalance }

/**
 * Fetches the connected wallet's L1 balance of `token` (default: the manifest token) once per
 * account/chain/token. The receive form uses that value as the amount ceiling while typing.
 */
export function useL1TokenBalance(opts: {
  account: Address | null
  wrongChain: boolean
  token?: Address
}): L1TokenBalance | undefined {
  const { account, wrongChain, token } = opts
  const [balance, setBalance] = useState<L1TokenBalance>()

  useEffect(() => {
    if (!account || wrongChain) {
      setBalance(undefined)
      return
    }
    let live = true
    setBalance(undefined)
    readL1DepositTokenBalance(account, token)
      .then((next) => {
        if (live) setBalance(next)
      })
      .catch(() => {
        if (live) setBalance(undefined)
      })
    return () => {
      live = false
    }
  }, [account, wrongChain, token])

  return balance
}

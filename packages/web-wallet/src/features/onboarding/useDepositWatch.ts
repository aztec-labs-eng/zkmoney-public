import { useCallback, useEffect, useRef, useState } from "react"
import type { Address } from "viem"
import { readSipaHolding } from "@obsidion/front-core"
import type { WebWalletConfig } from "../../config/env"
import { l1PublicClient } from "../../config/oxideTuple"
import { sipaFundingTokens } from "../deposit/loadDepositFacts"

const POLL_MS = 5_000

/** What the address holds, in fee-token units, and the token holding it once there is one. */
export interface DepositWatch {
  balance: bigint
  token?: Address
  /** When the address was last read, unix ms. */
  readAt?: number
  /** Reads the address now, ahead of the poll. Settles once the read lands or fails. */
  read: () => Promise<void>
}

const NOTHING: { balance: bigint; token?: Address; readAt?: number } = { balance: 0n }

/**
 * The deposit address's largest token balance, polled while the step waits on it, so the screen
 * can say "received" the moment the transfer lands instead of on the registration machine's next
 * tick. Presentation only: the machine's own L1 reads stay the custody source of truth.
 */
export function useDepositWatch(
  config: WebWalletConfig,
  watch: { token: Address; address: Address } | null,
): DepositWatch {
  const [observed, setObserved] = useState<{
    at: string
    balance: bigint
    token?: Address
    readAt: number
  }>()
  const readRef = useRef<() => Promise<void>>(undefined)
  // The boot config, read as the watch starts: its identity never restarts the watch.
  const configRef = useRef(config)
  configRef.current = config
  const token = watch?.token
  const address = watch?.address
  const at = `${token}:${address}`
  useEffect(() => {
    if (!token || !address) return
    let live = true
    const config = configRef.current
    const client = l1PublicClient(config)
    const tokens = sipaFundingTokens(config.network, token)
    // The poll and a manual read overlap; a read that lands after a newer one is stale.
    let started = 0
    let applied = 0
    const read = async () => {
      const mine = ++started
      try {
        const holding = await readSipaHolding(client, address, tokens)
        const seen = holding.status.scaledBalance
        const held = seen > 0n ? holding.token.address : undefined
        if (!live || mine < applied) return
        applied = mine
        // Every landed read is new state: its time feeds the "Last checked" line.
        setObserved({ at, balance: seen, token: held, readAt: Date.now() })
      } catch (err) {
        console.warn("deposit balance read failed", err)
      }
    }
    readRef.current = read
    void read()
    const timer = setInterval(() => void read(), POLL_MS)
    return () => {
      live = false
      readRef.current = undefined
      clearInterval(timer)
    }
  }, [token, address, at])
  const read = useCallback(() => readRef.current?.() ?? Promise.resolve(), [])
  // Never carry the previous address's balance into a newly selected registration.
  const held = observed?.at === at ? observed : NOTHING
  return { balance: held.balance, token: held.token, readAt: held.readAt, read }
}

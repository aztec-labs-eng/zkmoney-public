import { useEffect, useState } from "react"
import { parseAbi, type Address } from "viem"
import type { WebWalletConfig } from "../../config/env"
import { l1PublicClient } from "../../config/oxideTuple"

const BALANCE_ABI = parseAbi(["function balanceOf(address) view returns (uint256)"])
const POLL_MS = 5_000

/**
 * The deposit address's token balance, polled while the step waits on it, so the screen can say
 * "received" the moment the transfer lands instead of on the registration machine's next tick.
 * Presentation only: the machine's own L1 reads stay the custody source of truth.
 */
export function useDepositWatch(
  config: WebWalletConfig,
  watch: { token: Address; address: Address } | null,
): bigint {
  const [observed, setObserved] = useState<{ at: string; balance: bigint }>()
  const token = watch?.token
  const address = watch?.address
  const at = `${token}:${address}`
  useEffect(() => {
    if (!token || !address) return
    let live = true
    const client = l1PublicClient(config)
    const read = async () => {
      try {
        const seen = await client.readContract({
          address: token,
          abi: BALANCE_ABI,
          functionName: "balanceOf",
          args: [address],
        })
        // Same balance at the same address is the same state: re-storing it would re-run this effect.
        if (live)
          setObserved((prev) =>
            prev?.at === at && prev.balance === seen ? prev : { at, balance: seen },
          )
      } catch (err) {
        console.warn("deposit balance read failed", err)
      }
    }
    void read()
    const timer = setInterval(() => void read(), POLL_MS)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [config, token, address, at])
  // Never carry the previous address's balance into a newly selected registration.
  return observed?.at === at ? observed.balance : 0n
}

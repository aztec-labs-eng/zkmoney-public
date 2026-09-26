import { useEffect, useState } from "react"
import { isAddress, type Address } from "viem"
import { getConfig } from "../../config/env"
import { l1PublicClient } from "../../config/oxideTuple"

/**
 * Whether an ETH-route recipient looks like a contract.
 *
 * `SwapEscrow`'s ETH leg pays the recipient with a plain call, and the route, recipient and tip are
 * immutable clone args baked into the escrow's CREATE2 address — so a recipient that rejects ETH
 * makes `execute` revert forever with the DAI stranded at the escrow and no way to re-route it.
 *
 * Presence of code is a warning, not a verdict: an EIP-7702 delegated EOA carries code and accepts
 * ETH fine. Unknown (still loading, or an RPC that would not answer) stays silent rather than
 * blocking a withdrawal on a failed probe.
 */
export function useEthRecipientHasCode(recipient: string, enabled: boolean): boolean {
  const [hasCode, setHasCode] = useState(false)

  useEffect(() => {
    if (!enabled || !isAddress(recipient)) {
      setHasCode(false)
      return
    }
    let active = true
    void (async () => {
      try {
        const code = await l1PublicClient(getConfig()).getCode({ address: recipient as Address })
        if (active) setHasCode(!!code && code !== "0x")
      } catch {
        if (active) setHasCode(false)
      }
    })()
    return () => {
      active = false
    }
  }, [recipient, enabled])

  return hasCode
}

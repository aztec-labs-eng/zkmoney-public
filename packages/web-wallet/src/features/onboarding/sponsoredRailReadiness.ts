/**
 * Whether the sponsored rail can carry a subscribe for this account yet, and why not when it cannot.
 *
 * This answers readiness, not billability: it asks whether this account can ride the sponsored rail
 * at all, and it supplies no operation calls, so it cannot say that any particular batch will be
 * paid for. The route gate uses it to hold flows that would only be refused on chain.
 */
import { useEffect, useState } from "react"
import { waitForRegistrationMessage } from "@obsidion/sdk"
import { useAccountContext, useAztecContext, useContractServiceContext } from "@obsidion/front-core"
import { claimSponsorContext } from "./claimSponsorship"
import { RegistrationPendingError, type RegistrationPending } from "./registrationRail"
import { RAIL_REGISTERED } from "./rails"

/**
 * Why this account cannot ride the sponsored rail yet, or false when it can: it holds a subscription
 * note, or its registration message is ready. A read that cannot answer is `read-error`, which
 * blocks the route and is re-asked on the same timer, so an outage never reads as ready.
 */
export async function sponsoredRailPending(
  deps: Parameters<typeof claimSponsorContext>[0],
): Promise<RegistrationPending | false> {
  try {
    await claimSponsorContext(deps, RAIL_REGISTERED)
    return false
  } catch (error) {
    if (error instanceof RegistrationPendingError) return error.state
    return { pending: "read-error" }
  }
}

/** How long the gate waits before re-asking L1 or the PXE; the sweep takes a few L1 blocks. */
const RECHECK_INTERVAL_MS = 12_000

/**
 * {@link sponsoredRailPending} for the route gate: `undefined` until the wallet services exist and
 * the reads answer (a registered account is not pending in that window, only unknown), then
 * re-asked while pending so the held screen opens on its own. A message the rollup has yet to
 * import is waited on through the node rather than re-scanned from L1. A `false` here means the
 * account can ride the rail, not that any given batch is paid for.
 */
export function useSponsoredRailPending(): boolean | undefined {
  const { obsidionWallet } = useAztecContext()
  const { obsidionAccount } = useAccountContext()
  const { contractService } = useContractServiceContext()
  const [pending, setPending] = useState<boolean>()
  useEffect(() => {
    if (!obsidionWallet || !obsidionAccount || !contractService) return
    let timer: ReturnType<typeof setTimeout> | undefined
    let live = true
    const check = async () => {
      const waiting = await sponsoredRailPending({
        wallet: obsidionWallet,
        account: obsidionAccount,
        contractService,
      })
      if (!live) return
      setPending(Boolean(waiting))
      if (!waiting) return
      if (waiting.pending === "import") {
        await waitForRegistrationMessage(obsidionWallet.node, waiting.messageHash, {
          timeoutSeconds: RECHECK_INTERVAL_MS / 1000,
        }).catch(() => undefined)
        if (live) void check()
      } else {
        timer = setTimeout(() => void check(), RECHECK_INTERVAL_MS)
      }
    }
    void check()
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [obsidionWallet, obsidionAccount, contractService])
  return pending
}

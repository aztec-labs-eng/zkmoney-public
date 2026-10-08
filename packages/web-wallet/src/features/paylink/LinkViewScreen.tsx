import { useEffect, useMemo, useRef, useState } from "react"
import { useLocation, useNavigate } from "react-router-dom"
import { useAztecContext, useContractServiceContext } from "@obsidion/front-core"
import { Card, ScreenNavBar, Spinner } from "@obsidion/web-ds"
import { showReportableError } from "../../errors/errorModal"
import { loadOnboardedIdentity } from "../identity/walletIdentity"
import { OnboardingLayout } from "../../ui/OnboardingLayout"
import { stashClaimLink } from "./claimStash"
import { PaylinkVisitorScreen } from "./PaylinkVisitorScreen"
import {
  decodeLink,
  EmailPaylinkUnsupportedError,
  emitLinkOpened,
  type ViewLinkDeps,
} from "./sponsoredPaylink"
import { watchLink } from "./linkStatus"
import { usePolledChainSeconds } from "./chainTime"
import { withExpiry } from "./claimWindow"
import type { PaymentLink } from "./types"

/**
 * `/link#fragment`. A signed-in browser claims on Home (ClaimLinkModal), the link's creator
 * included — a creator's recoveries live on the row's detail sheet. No account: the signup page
 * with the amount above it. A fragment that does not decode, or an email link while email-locked
 * links are off, stays here on its error card: nothing is stashed and no signup is offered.
 */
export function LinkViewScreen() {
  const navigate = useNavigate()
  const location = useLocation()
  const { obsidionWallet, rollupAddress } = useAztecContext()
  const { contractService } = useContractServiceContext()
  const fragment = location.hash.replace(/^#/, "")

  const [decoded, unsupported] = useMemo((): [PaymentLink | null, boolean] => {
    try {
      return [fragment ? decodeLink(fragment) : null, false]
    } catch (e) {
      return [null, e instanceof EmailPaylinkUnsupportedError]
    }
  }, [fragment])
  // Pinned to this mount: the signup wizard writing an identity must not unmount itself.
  const [visitor] = useState(() => !loadOnboardedIdentity())
  const handoff = !visitor && decoded !== null

  useEffect(() => {
    if (!handoff) return
    stashClaimLink(fragment)
    navigate("/", { replace: true })
  }, [handoff, fragment, navigate])

  // Claim-funnel top for the visitor page; a handoff mount stays silent — useClaimLinkFlow emits.
  const openedFragment = useRef<string>(undefined)
  useEffect(() => {
    if (handoff || !decoded || !rollupAddress || openedFragment.current === fragment) return
    openedFragment.current = fragment
    emitLinkOpened(rollupAddress, fragment)
  }, [handoff, decoded, fragment, rollupAddress])

  // Status needs only wallet + contracts, no passkey: the visitor page says when the link is
  // already claimed.
  const statusDeps: ViewLinkDeps | undefined = useMemo(
    () =>
      obsidionWallet && contractService ? { wallet: obsidionWallet, contractService } : undefined,
    [obsidionWallet, contractService],
  )
  const [status, setStatus] = useState<PaymentLink | null>(null)
  const chainNow = usePolledChainSeconds(obsidionWallet?.node)
  // Settled either way: the visitor page's voucher read waits on it, and a failed check must not
  // hold that read forever.
  const [statusSettled, setStatusSettled] = useState(false)
  const [statusAttempt, setStatusAttempt] = useState(0)
  useEffect(() => {
    if (handoff || !decoded || !statusDeps) return
    setStatusSettled(false)
    return watchLink(
      statusDeps,
      fragment,
      setStatus,
      // Transport failures keep the decoded view but tell the user the status is unverified.
      (e: unknown) => {
        showReportableError(e, "paylink:status", {
          message: `Could not check the link's status: ${
            e instanceof Error ? e.message : String(e)
          }`,
        })
      },
      () => setStatusSettled(true),
    )
  }, [handoff, decoded, statusDeps, fragment, statusAttempt])

  if (handoff) {
    return (
      <div style={{ display: "flex", justifyContent: "center", padding: 48 }}>
        <Spinner size={20} />
      </div>
    )
  }

  const link = status?.fragment === fragment ? status : decoded
  if (link)
    return (
      <PaylinkVisitorScreen
        link={withExpiry(link, chainNow)}
        statusSettled={statusSettled}
        onRetryStatus={() => setStatusAttempt((n) => n + 1)}
      />
    )

  return (
    <OnboardingLayout>
      <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
        <ScreenNavBar title="Payment link" onLeading={() => navigate("/")} />
        <Card style={{ marginTop: 24 }}>
          <div style={{ textAlign: "center", padding: "18px 8px", color: "var(--text-secondary)" }}>
            {unsupported
              ? "Email-locked payment links aren't supported in this wallet. Ask the sender for a new link."
              : "This link is malformed or incomplete. Check that the full URL was copied."}
          </div>
        </Card>
      </div>
    </OnboardingLayout>
  )
}

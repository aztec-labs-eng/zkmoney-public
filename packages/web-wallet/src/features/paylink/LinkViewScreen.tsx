import { useEffect, useMemo, useRef, useState } from "react"
import { useLocation, useNavigate } from "react-router-dom"
import { serviceStatus, useStore } from "@obsidion/front-core"
import {
  DEFAULT_CONTRACTS,
  decodeLinkFragment,
  encodePaylinkInline,
  getHardcodedArtifact,
  LINK_CLASS_REFUSAL,
  LinkKind,
  resolveShortPaylink,
} from "@obsidion/sdk"
import { Card, ScreenNavBar, Spinner } from "@obsidion/web-ds"
import { showReportableError } from "../../errors/errorModal"
import { enteredIdentity } from "../../session/account"
import { OnboardingLayout } from "../../ui/OnboardingLayout"
import { BootSplash } from "../../ui/PxeBoot"
import { stashClaimLink } from "./claimStash"
import { tabStash } from "../../platform/storage/tabStash"
import { PaylinkVisitorScreen } from "./PaylinkVisitorScreen"
import { EmailPaylinkUnsupportedError, emitLinkOpened } from "./sponsoredPaylink"
import { seededLink, watchLink } from "./linkStatus"
import { usePolledChainSeconds } from "./chainTime"
import { withExpiry } from "./claimWindow"
import type { PaymentLink } from "./types"
import { useShortLinkLookup } from "../shortLinks"
import { chainOf, useSession } from "../../session/session"

/**
 * `/link#fragment`. A short link's fragment is looked up on chain first and replaced by the full
 * link, so everything past this point reads the full fragment.
 */
export function LinkViewScreen() {
  const location = useLocation()
  const fragment = location.hash.replace(/^#/, "")
  const short = useMemo(() => {
    const decoded = decodeLinkFragment(fragment)
    return decoded?.kind === LinkKind.Paylink ? decoded.seed : undefined
  }, [fragment])
  return short ? <ShortLinkView seed={short} /> : <FullLinkView fragment={fragment} />
}

function ShortLinkView({ seed }: { seed: Uint8Array }) {
  const navigate = useNavigate()
  const session = useSession()
  const walletBuilt = useStore(session.wallet, serviceStatus) === "ready"
  const contracts = useStore(session.contractService, serviceStatus) === "ready"
  const resolve = useMemo(() => {
    if (!walletBuilt || !contracts) return undefined
    return async () => {
      const { wallet, contractService } = await chainOf(session)
      const params = await resolveShortPaylink({ node: wallet.node, contractService }, seed)
      return params && encodePaylinkInline(params)
    }
  }, [session, walletBuilt, contracts, seed])
  const refused = useShortLinkLookup(
    resolve,
    (fragment) => navigate(`/link#${fragment}`, { replace: true }),
    // eslint-disable-next-line local/message-in-state -- debt
    (e) => (e instanceof Error && e.message === LINK_CLASS_REFUSAL ? e.message : undefined),
  )

  if (!refused) return <BootSplash />
  return (
    <OnboardingLayout>
      <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
        <ScreenNavBar title="Payment link" onLeading={() => navigate("/")} />
        <Card style={{ marginTop: 24 }}>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 12,
              padding: "18px 8px",
              color: "var(--text-secondary)",
              textAlign: "center",
            }}
          >
            {refused}
          </div>
        </Card>
      </div>
    </OnboardingLayout>
  )
}

/**
 * A full link. A signed-in browser claims on Home (ClaimLinkModal), the link's creator included — a
 * creator's recoveries live on the row's detail sheet. No account: the signup page with the amount
 * above it. A fragment that does not decode, or an email link while email-locked links are off,
 * stays here on its error card: nothing is stashed and no signup is offered.
 */
function FullLinkView({ fragment }: { fragment: string }) {
  const navigate = useNavigate()
  const session = useSession()
  const rollupAddress = useStore(session.page.networkId)
  const contracts = useStore(session.contractService, serviceStatus) === "ready"

  const [decoded, unsupported] = useMemo((): [PaymentLink | null, boolean] => {
    try {
      return [fragment ? seededLink(session.page.config, fragment) : null, false]
    } catch (e) {
      return [null, e instanceof EmailPaylinkUnsupportedError]
    }
  }, [fragment])
  // Pinned to this mount: the signup wizard writing an identity must not unmount itself.
  const { identity, device } = session
  const [visitor] = useState(
    () =>
      enteredIdentity(identity.get(), device.get().passkeyMap, session.page.config.rpId) === null,
  )
  const handoff = !visitor && decoded !== null

  // eslint-disable-next-line local/effect-hook -- debt
  useEffect(() => {
    if (!handoff) return
    stashClaimLink(tabStash, fragment)
    navigate("/", { replace: true })
  }, [handoff, fragment, navigate])

  // Fetched while the PXE registers the escrow's class, which needs no network: the simulator's
  // wasm, and the token and ClaimFPC artifacts an unclaimed link's reads register next.
  // eslint-disable-next-line local/effect-hook -- debt
  useEffect(() => {
    if (handoff || !decoded) return
    void session.page.noirWasm().catch(() => {})
    for (const contract of [DEFAULT_CONTRACTS.oxideToken, DEFAULT_CONTRACTS.claimFpc]) {
      void getHardcodedArtifact(contract).catch(() => {})
    }
  }, [handoff, decoded])

  // Claim-funnel top for the visitor page; a handoff mount stays silent — useClaimLinkFlow emits.
  const openedFragment = useRef<string>(undefined)
  // eslint-disable-next-line local/effect-hook -- debt
  useEffect(() => {
    if (handoff || !decoded || !rollupAddress || openedFragment.current === fragment) return
    openedFragment.current = fragment
    emitLinkOpened(rollupAddress, fragment)
  }, [handoff, decoded, fragment, rollupAddress])

  // Status needs only wallet + contracts, no passkey: the visitor page says when the link is
  // already claimed.
  const statusReadable = !!rollupAddress && contracts
  const [status, setStatus] = useState<PaymentLink | null>(null)
  const chainNow = usePolledChainSeconds()
  // Settled either way: the visitor page's voucher read waits on it, and a failed check must not
  // hold that read forever.
  const [statusSettled, setStatusSettled] = useState(false)
  const [noteMissed, setNoteMissed] = useState(false)
  const [statusAttempt, setStatusAttempt] = useState(0)
  // eslint-disable-next-line local/effect-hook -- debt
  useEffect(() => {
    if (handoff || !decoded || !statusReadable) return
    setStatusSettled(false)
    setNoteMissed(false)
    let stopped = false
    let stop: (() => void) | undefined
    void chainOf(session).then((chain) => {
      if (stopped) return
      stop = watchLink(
        { session, ...chain },
        fragment,
        setStatus,
        // Transport failures keep the decoded view but tell the user the status is unverified.
        (e: unknown) => {
          showReportableError(e, "paylink:status", {
            message: `Could not check the link's status: ${
              // eslint-disable-next-line local/message-in-state -- debt
              e instanceof Error ? e.message : String(e)
            }`,
          })
        },
        (noteRead) => {
          setStatusSettled(true)
          setNoteMissed(!noteRead)
        },
      )
    })
    return () => {
      stopped = true
      stop?.()
    }
  }, [handoff, decoded, statusReadable, session, fragment, statusAttempt])

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
        noteMissed={noteMissed}
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

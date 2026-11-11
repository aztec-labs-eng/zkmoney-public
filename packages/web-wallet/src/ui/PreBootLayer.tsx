import { useEffect, useState } from "react"
import { createPortal } from "react-dom"
import { Router, useNavigate } from "react-router-dom"
import { isDemoMode } from "../dev/demoFlag"
import { hasConnectStash } from "../features/contacts/connectReceive"
import { InvitationChrome } from "../features/onboarding/InvitationChrome"
import { readDrawnOffer } from "../features/registration/signupStash"
import { CreateWalletLanding } from "../features/onboarding/steps/CreateWalletStep/CreateWalletStep"
import { useLandingRate } from "../features/onboarding/steps/LandingFeatureCards"
import { stashClaimLink } from "../features/paylink/claimStash"
import { withExpiry } from "../features/paylink/claimWindow"
import { usePageTicketOffer } from "../features/paylink/goldenTicketOffer"
import type { WebWalletConfig } from "../config/env"
import type { PageTicketOffer } from "../features/paylink/ticketOffer"
import { seededLink } from "../features/paylink/linkStatus"
import { PaylinkVisitorPending } from "../features/paylink/PaylinkVisitorScreen"
import type { PaymentLink } from "../features/paylink/types"
import { useOriginWasFresh } from "../platform/storage/freshOrigin"
import { tabStash } from "../platform/storage/tabStash"
import { ShellRoot } from "./AppShell/AppShell"
import { IdleBell } from "./NotificationsBell/NotificationsBell"
import type { PreBoot } from "../session/preBoot"
import { useStore } from "@obsidion/front-core"
import type { LandingRate } from "../features/savings/savingsGateway"
import { useFirstScreenShown, type BootPage } from "./PxeBoot"

type PreBootPage = { kind: "landing" } | { kind: "link"; link: PaymentLink }
type PreBootProps = { preBoot: PreBoot; page: BootPage; landingRate: LandingRate }
type LayerProps = PreBootProps & { ticketOffer: PageTicketOffer }
type VisitorProps = { link: PaymentLink; page: BootPage; ticketOffer: PageTicketOffer }

/** The page the wallet opens on for a visitor with nothing stored, where one can stand in for it. */
function preBootPage(config: WebWalletConfig): PreBootPage | undefined {
  try {
    // A dev build's `?mock=` onboarding preview opens its own modals.
    const preview = import.meta.env.DEV && new URLSearchParams(location.search).has("mock")
    if (isDemoMode() || preview || readDrawnOffer(tabStash) || hasConnectStash(tabStash))
      return undefined
    const { pathname, search, hash } = location
    if (pathname === "/") return { kind: "landing" }
    if (pathname === "/claim") {
      const params = new URLSearchParams(search)
      const resumed = params.get("resume") === "1" || params.get("recovery") === "1"
      return resumed ? undefined : { kind: "landing" }
    }
    const fragment = hash.replace(/^#/, "")
    if (pathname === "/link" && fragment) {
      return { kind: "link", link: withExpiry(seededLink(config, fragment), undefined) }
    }
  } catch {
    // A link that does not decode waits for its error card.
  }
  return undefined
}

/**
 * The first screen while the wallet starts, for a visitor on an origin with no wallet database: the
 * landing, or a payment link's page with every read pending. It takes the boot screen's place
 * outside the app's root until the app draws its own first screen, which is the same screen, so
 * the visitor sees it seconds sooner and nothing changes when the app takes over. A tap that needs
 * the wallet waits for it (`session/preBoot`).
 */
export function PreBootLayer({ preBoot, page: bootPage, landingRate, ticketOffer }: LayerProps) {
  const [page] = useState(() => preBootPage(bootPage.config))
  const fresh = useOriginWasFresh()
  const shown = useFirstScreenShown()
  const { left } = useStore(preBoot.taps)
  const host = document.getElementById("pre-boot")
  if (!page || !fresh || shown || left || !host) return null
  return createPortal(
    <Router
      location={location.pathname + location.search + location.hash}
      navigator={preBoot.navigator}
    >
      {page.kind === "landing" ? (
        <PreBootLanding preBoot={preBoot} page={bootPage} landingRate={landingRate} />
      ) : (
        <PreBootVisitor link={page.link} page={bootPage} ticketOffer={ticketOffer} />
      )}
    </Router>,
    host,
  )
}

function PreBootLanding({ preBoot, page, landingRate }: PreBootProps) {
  const busy = useStore(preBoot.taps).create
  const navigate = useNavigate()
  // A landing that waits for its live rate leaves the boot screen up until then.
  if (!useLandingRate(landingRate).ready) return null
  return (
    <ShellRoot>
      <InvitationChrome bare landing page={page}>
        <CreateWalletLanding
          busy={busy}
          landingRate={landingRate}
          onCreate={() => preBoot.setCreate(true)}
          onLogIn={() => navigate("/enter", { replace: true })}
          onCancel={() => preBoot.setCreate(false)}
        />
      </InvitationChrome>
    </ShellRoot>
  )
}

function PreBootVisitor({ link, page, ticketOffer }: VisitorProps) {
  const navigate = useNavigate()
  // Saved as the page does, so a sign-in started here still claims the link.
  // eslint-disable-next-line local/effect-hook -- debt
  useEffect(() => stashClaimLink(tabStash, link.fragment), [link.fragment])
  // The offer needs no wallet: read now, the page has it when it mounts.
  const offer = usePageTicketOffer(ticketOffer)
  return (
    <ShellRoot>
      <PaylinkVisitorPending
        link={link}
        offer={offer}
        bell={<IdleBell />}
        onLogIn={() => navigate("/enter?choose=1")}
        page={page}
      />
    </ShellRoot>
  )
}

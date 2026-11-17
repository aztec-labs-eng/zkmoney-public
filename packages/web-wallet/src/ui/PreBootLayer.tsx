import { useState } from "react"
import { createPortal } from "react-dom"
import { Navigate, Router, useNavigate } from "react-router-dom"
import { isDemoMode } from "../dev/demoFlag"
import { hasConnectStash } from "../features/contacts/connectReceive"
import { InvitationChrome } from "../features/onboarding/InvitationChrome"
import { readDrawnOffer } from "../features/registration/signupStash"
import { CreateWalletLanding } from "../features/onboarding/steps/CreateWalletStep/CreateWalletStep"
import { useLandingRate } from "../features/onboarding/steps/LandingFeatureCards"
import { stashClaimLink } from "../features/paylink/claimStash"
import { decodeLink } from "../features/paylink/sponsoredPaylink"
import type { WebWalletConfig } from "../config/env"
import { useOriginWasFresh } from "../platform/storage/freshOrigin"
import { tabStash } from "../platform/storage/tabStash"
import { ShellRoot } from "./AppShell/AppShell"
import type { PreBoot } from "../session/preBoot"
import { useStore } from "@obsidion/front-core"
import type { LandingRate } from "../features/savings/landingRate"
import { useFirstScreenShown, type BootPage } from "./PxeBoot"

type PreBootPage = { kind: "landing" } | { kind: "link"; fragment: string }
type PreBootProps = { preBoot: PreBoot; page: BootPage; landingRate: LandingRate }

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
      decodeLink(config, fragment)
      return { kind: "link", fragment }
    }
  } catch {
    // A link that does not decode waits for its error card.
  }
  return undefined
}

/**
 * The first screen while the wallet starts, for a visitor on an origin with no wallet database: the
 * landing. It takes the boot screen's place outside the app's root until the app draws its own
 * first screen, which is the same screen, so the visitor sees it seconds sooner and nothing changes
 * when the app takes over. A tap that needs the wallet waits for it (`session/preBoot`).
 */
export function PreBootLayer({ preBoot, page: bootPage, landingRate }: PreBootProps) {
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
        <LinkToLanding fragment={page.fragment} />
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

/**
 * A full payment link on a first visit: the visitor signs up on the landing, and the link waits in
 * the tab for the account, as a signed-in visitor's does on `/link`.
 */
function LinkToLanding({ fragment }: { fragment: string }) {
  useState(() => stashClaimLink(tabStash, fragment))
  return <Navigate to="/" replace />
}

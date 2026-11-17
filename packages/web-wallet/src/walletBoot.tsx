import { BootGate } from "./BootGate"
import bakedProfile from "virtual:baked-config-profile"
import bakedFeatures from "virtual:baked-features"
import { resolveBootConfig, type ResolveBootConfigInput } from "./config/env"
import { lazy, Suspense, useState } from "react"
import type { Pace } from "@obsidion/core/cadence"
import { queries, type QueryEntry } from "@obsidion/front-core"
import { demoScenario } from "./dev/demoFlag"
import { markInAppBrowser } from "./features/identity/inAppHost"
import { warmBoot } from "./bootWarmup"
import { documentVisible, openPage, type PageBoot } from "./app/sessionDeps"
import { claimActiveTab } from "./ActiveTabGate/ActiveTabGate"
import { GOOGLE_CALLBACK_PATH } from "./features/paylink/googleRelay"
import { pagePace } from "./platform/pagePace"

// Design-system styles + the Sen brand font (source CSS; the vite alias maps the
// component imports to source too). After the wallet's imports, so they win ties with its CSS.
import "../../design-system/src/styles/styles.css"
import "../../design-system/src/styles/cards-modals.css"

// A demo page boots no PXE, so it skips the proving downloads.
if (!(import.meta.env.DEV && demoScenario())) void warmBoot(location.pathname)
markInAppBrowser()

/** The config editor's draft over `input`, where it is on. */
async function previewInput(input: ResolveBootConfigInput): Promise<ResolveBootConfigInput> {
  return import.meta.env.VITE_CONFIG_EDITOR === "true"
    ? { ...input, fetchImpl: (await import("./dev/configDraft")).configDraftFetch(input.fetchImpl) }
    : input
}

/** The real app's page, over the real profile. */
async function realBoot(pace: Pace, profileFetch?: typeof fetch): Promise<PageBoot> {
  const config = await resolveBootConfig(
    await previewInput({ bakedProfile, bakedFeatures, fetchImpl: profileFetch }),
  )
  const onboardingMock = import.meta.env.DEV
    ? (await import("./dev/mockOnboarding")).mockOnboarding
    : undefined
  const page = openPage(config, { onboardingMock, pace })
  // Google's OAuth popup only relays a token to the active tab, so it never takes the lock.
  if (location.pathname !== GOOGLE_CALLBACK_PATH) claimActiveTab(page)
  return { ...config, page }
}

/**
 * The page's boot read over `load`, on the pace the page it builds then polls on. StrictMode's
 * second subscribe joins the read in flight, and a read after a failure starts a new one. It loads
 * once `after` settles. The landing's rate needs only the config, so its read starts with the boot.
 */
function bootRead(
  load: (pace: Pace) => Promise<PageBoot>,
  after?: Promise<void>,
): QueryEntry<PageBoot> {
  const pace = pagePace()
  return queries({ pace, visible: documentVisible, now: Date.now })<[], PageBoot>("boot", {
    load: async () => {
      await after
      const boot = await load(pace)
      void boot.page.landingRate.read()
      return boot
    },
  })()
}

// `import.meta.env.DEV` is a build-time literal: production drops the demo boot and its chunk.
const DemoBoot = import.meta.env.DEV
  ? lazy(() => import("./dev/DemoBoot").then((m) => ({ default: m.DemoBoot })))
  : null

export default function WalletBoot({ profileFetch }: { profileFetch?: typeof fetch }) {
  const scenario = DemoBoot && demoScenario()
  if (DemoBoot && scenario)
    return (
      <Suspense fallback={null}>
        <DemoBoot
          scenario={scenario}
          read={bootRead}
          preview={previewInput}
          real={(pace) => realBoot(pace)}
        />
      </Suspense>
    )
  return <RealBoot profileFetch={profileFetch} />
}

function RealBoot({ profileFetch }: { profileFetch?: typeof fetch }) {
  const [boot] = useState(() => bootRead((pace) => realBoot(pace, profileFetch)))
  return <BootGate boot={boot} />
}

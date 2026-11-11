import { BootGate } from "./BootGate"
import bakedProfile from "virtual:baked-config-profile"
import { resolveBootConfig, type ResolveBootConfigInput } from "./config/env"
import { useState } from "react"
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

/**
 * Profile first, fixtures last: `seedDemo` builds its page over the resolved boot config, and writes
 * account-scoped keys under the session pointers.
 * Dev-only `?demo=<scenario>` boots from the in-process demo profile, so it needs no config
 * service, then seeds before the first render so every hook's first read sees a populated wallet.
 * `import.meta.env.DEV` is a build-time literal — production drops the branch and the chunks
 * behind it.
 */
async function resolveAndSeed(pace: Pace, profileFetch?: typeof fetch): Promise<PageBoot> {
  const previewInput = async (input: ResolveBootConfigInput): Promise<ResolveBootConfigInput> =>
    import.meta.env.VITE_CONFIG_EDITOR === "true"
      ? {
          ...input,
          fetchImpl: (await import("./dev/configDraft")).profileDraftFetch(input.fetchImpl),
        }
      : input
  const scenario = import.meta.env.DEV ? demoScenario() : null
  const resolved = scenario
    ? await resolveBootConfig(
        await previewInput((await import("./dev/demoProfile")).demoBootInput()),
      )
    : await resolveBootConfig(await previewInput({ bakedProfile, fetchImpl: profileFetch }))
  const seeded =
    scenario &&
    (await (await import("./dev/seedDemo")).seedDemo(scenario, resolved, undefined, pace))
  if (seeded) return { ...resolved, page: seeded }
  // A refusal (this origin holds a real wallet) boots the real app from the real profile.
  const config = scenario ? await resolveBootConfig(await previewInput({ bakedProfile })) : resolved
  const onboardingMock = import.meta.env.DEV
    ? (await import("./dev/mockOnboarding")).mockOnboarding
    : undefined
  const page = openPage(config, { onboardingMock, pace })
  // Google's OAuth popup only relays a token to the active tab, so it never takes the lock.
  if (location.pathname !== GOOGLE_CALLBACK_PATH) claimActiveTab(page)
  return { ...config, page }
}

/** The landing's rate needs only the config, so its read starts with it rather than with the app. */
async function resolveAndPrefetch(pace: Pace, profileFetch?: typeof fetch): Promise<PageBoot> {
  const resolved = await resolveAndSeed(pace, profileFetch)
  void resolved.page.landingRate.read()
  return resolved
}

/**
 * The page's configuration read, over the pace the page it builds then polls on. StrictMode's second
 * subscribe joins the read in flight, and a read after a failure starts a new one.
 */
function bootRead(profileFetch?: typeof fetch): QueryEntry<PageBoot> {
  const pace = pagePace()
  return queries({ pace, visible: documentVisible, now: Date.now })<[], PageBoot>("boot", {
    load: () => resolveAndPrefetch(pace, profileFetch),
  })()
}

export default function WalletBoot({ profileFetch }: { profileFetch?: typeof fetch }) {
  const [boot] = useState(() => bootRead(profileFetch))
  return <BootGate boot={boot} />
}

import { BootGate } from "./BootGate"
import bakedProfile from "virtual:baked-config-profile"
import { getConfig, resolveBootConfig, type ResolveBootConfigInput } from "./config/env"
import { profileFetch } from "./config/profilePrefetch"
import { demoScenario } from "./dev/demoFlag"
import { markInAppBrowser } from "./features/identity/inAppHost"
import { warmBoot } from "./bootWarmup"
import { setSponsorAccountsResolver } from "./features/registration/claimSponsorship"
import { sessionSponsorAccounts } from "./features/registration/sponsorAccounts"
import { prefetchLiveSavingsApy } from "./features/savings/savingsGateway"
import { openPage, type PageBoot } from "./app/sessionDeps"

// Design-system styles + the Sen brand font (source CSS; the vite alias maps the
// component imports to source too). After the wallet's imports, so they win ties with its CSS.
import "../../design-system/src/styles/styles.css"
import "../../design-system/src/styles/cards-modals.css"

void warmBoot(location.pathname)
markInAppBrowser()

/**
 * Profile first, fixtures last: `seedDemo` reads `getConfig()`, which exists only once
 * `resolveBootConfig` has seeded it, and writes account-scoped keys under the session pointers.
 * Dev-only `?demo=<scenario>` boots from the in-process demo profile, so it needs no config
 * service, then seeds before the first render so every hook's first read sees a populated wallet.
 * `import.meta.env.DEV` is a build-time literal — production drops the branch and the chunks
 * behind it.
 */
async function resolveAndSeed(): Promise<PageBoot> {
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
  const seeded = scenario && (await (await import("./dev/seedDemo")).seedDemo(scenario))
  if (seeded) return withSponsorAccounts({ ...resolved, page: seeded })
  // A refusal (this origin holds a real wallet) boots the real app from the real profile.
  const config = scenario ? await resolveBootConfig(await previewInput({ bakedProfile })) : resolved
  const onboardingMock = import.meta.env.DEV
    ? (await import("./dev/mockOnboarding")).mockOnboarding
    : undefined
  return withSponsorAccounts({ ...config, page: openPage(getConfig(), { onboardingMock }) })
}

/** Sponsored batches name their payer through the page's auth service. */
function withSponsorAccounts(boot: PageBoot): PageBoot {
  setSponsorAccountsResolver(sessionSponsorAccounts(boot.page.auth))
  return boot
}

/** The landing's rate needs only the config, so its read starts with it rather than with the app. */
async function resolveAndPrefetch(): Promise<PageBoot> {
  const resolved = await resolveAndSeed()
  prefetchLiveSavingsApy()
  return resolved
}

export default function WalletBoot() {
  return <BootGate resolveBoot={resolveAndPrefetch} />
}

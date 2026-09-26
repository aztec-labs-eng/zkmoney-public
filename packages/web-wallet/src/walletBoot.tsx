import { BootGate } from "./BootGate"
import bakedProfile from "virtual:baked-config-profile"
import { resolveBootConfig, type WebBootConfig } from "./config/env"
import { demoScenario } from "./dev/demoFlag"
import { discardIncompatiblePasskeyState } from "./platform/auth/discardIncompatiblePasskeyState"

// Design-system styles + the Sen brand font (source CSS; the vite alias maps the
// component imports to source too). After the wallet's imports, so they win ties with its CSS.
import "../../design-system/src/styles/styles.css"
import "../../design-system/src/styles/cards-modals.css"

/**
 * Profile first, fixtures last: `seedDemo` reads `getConfig()`, which exists only once
 * `resolveBootConfig` has seeded it, and writes account-scoped keys under the session pointers.
 * Dev-only `?demo=<scenario>` boots from the in-process demo profile, so it needs no config
 * service, then seeds before the first render so every hook's first read sees a populated wallet.
 * `import.meta.env.DEV` is a build-time literal — production drops the branch and the chunks
 * behind it.
 */
async function resolveAndSeed(): Promise<WebBootConfig> {
  const scenario = import.meta.env.DEV ? demoScenario() : null
  const resolved = scenario
    ? await resolveBootConfig((await import("./dev/demoProfile")).demoBootInput())
    : await resolveBootConfig({ bakedProfile })
  await discardIncompatiblePasskeyState(resolved.config.rpId)
  if (!scenario) return resolved
  const { seedDemo } = await import("./dev/seedDemo")
  // A refusal (this origin holds a real wallet) boots the real app from the real profile.
  return (await seedDemo(scenario)) ? resolved : resolveBootConfig({ bakedProfile })
}

export default function WalletBoot() {
  return <BootGate resolveBoot={resolveAndSeed} />
}

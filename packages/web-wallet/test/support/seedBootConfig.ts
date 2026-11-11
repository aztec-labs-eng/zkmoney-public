/** Boot configs for tests, resolved from in-process profiles the way `main.tsx` boots. */
import { sandboxProfile, testnetProfile } from "../fixtures/sandboxProfile"

/** Where `test/setup.ts` puts the config a test page holds when its suite passes none. */
export const TEST_CONFIG = Symbol.for("zk.money/test-config")

/** The boot the sandbox profile resolves to. */
export const sandboxBoot = () =>
  boot(sandboxProfile(), "http://localhost:8083/profiles/sandbox.json")

/** The sandbox profile's config, as a page booted on it holds it. */
export const sandboxConfig = async () => (await sandboxBoot()).config

/** The testnet profile's config: its L1 has a public explorer. */
export const testnetConfig = async () =>
  (await boot(testnetProfile(), "https://cdn.zk.money/profiles/v5/current.json")).config

/** The testnet profile's config with `bridge` as its version's bridge block. */
export const bridgeConfig = async (bridge: unknown) => {
  const profile = testnetProfile()
  profile.versions[profile.current].bridge = bridge
  return (await boot(profile, "https://cdn.zk.money/profiles/v5/current.json")).config
}

async function boot(profile: { profileId: string; network: string }, profileUrl: string) {
  const { resolveBootConfig } = await import("../../src/config/env")
  return resolveBootConfig({
    env: {
      VITE_NETWORK: profile.network,
      VITE_CONFIG_PROFILE_URL: profileUrl,
      VITE_CONFIG_EXPECTED_PROFILE_ID: profile.profileId,
    },
    fetchImpl: (async () =>
      new Response(JSON.stringify(profile), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch,
  })
}

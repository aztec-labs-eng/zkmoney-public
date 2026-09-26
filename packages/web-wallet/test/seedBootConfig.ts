/**
 * Boot config for component tests.
 *
 * `getConfig()` throws until a profile has resolved, so any test that mounts a component reaching
 * for config has to boot one first — the app does it once in `main.tsx` before it renders anything.
 */
import { sandboxProfile } from "./fixtures/sandboxProfile"

const PROFILE_URL = "http://localhost:8083/profiles/sandbox.json"

/** Resolve the boot config from an in-process profile. Safe to call more than once. */
export async function seedBootConfig(): Promise<void> {
  const { resolveBootConfig } = await import("../src/config/env")
  await resolveBootConfig({
    env: {
      VITE_CONFIG_PROFILE_URL: PROFILE_URL,
      VITE_CONFIG_EXPECTED_PROFILE_ID: "sandbox",
    },
    fetchImpl: (async () =>
      new Response(JSON.stringify(sandboxProfile()), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch,
  })
}

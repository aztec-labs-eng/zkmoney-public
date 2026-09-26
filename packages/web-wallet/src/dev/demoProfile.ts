/**
 * The config profile demo mode boots from. The wallet has one boot path — a profile document
 * fetched from `VITE_CONFIG_PROFILE_URL` — and `seedDemo` reads the config it seeds, so demo mode
 * feeds that path an in-process document instead of asking for a config service. Every endpoint is
 * a placeholder: the PXE never boots, `fakeL1Rpc` answers the L1 URL, and the oxide tuple is primed
 * from `DEMO_OXIDE_TUPLE` (whose portal this pointer names) before anything could dial the manifest.
 */
import type { ResolveBootConfigInput } from "../config/env"
import { DEMO_OXIDE_TUPLE } from "./demoFixtures"

export const DEMO_PROFILE_ID = "demo"
export const DEMO_PROFILE_URL = "http://demo.invalid/profiles/demo.json"

const F32 = (n: number) => `0x${n.toString(16).padStart(64, "0")}`

export function demoProfile(): Record<string, unknown> {
  return {
    profileId: DEMO_PROFILE_ID,
    network: "sandbox",
    publishedAt: "2026-01-01T00:00:00.000Z",
    shared: { l1ChainId: 31337, xmtpEnv: "local", rollupVersion: DEMO_OXIDE_TUPLE.rollupVersion },
    current: "0.0.1",
    versions: {
      "0.0.1": {
        schemaVersion: "1",
        deployedAt: "2026-01-01T00:00:00.000Z",
        nodeUrl: "http://demo.invalid/node",
        l1RpcUrl: "http://demo.invalid/l1",
        accountServiceUrl: "http://demo.invalid/account",
        zkmoneyApiUrl: "http://demo.invalid/api",
        paylinkDomain: "http://demo.invalid/paylink",
        oxide: {
          manifestUrl: "http://demo.invalid/oxide/sandbox.json",
          portal: DEMO_OXIDE_TUPLE.portal,
        },
        contracts: {
          obsidionAccountAlpha: { classId: F32(1) },
          paylinkDirect: { classId: F32(2) },
          paylinkEmail: { classId: F32(3) },
        },
      },
    },
  }
}

/**
 * `resolveBootConfig` input for demo mode: boot from {@link demoProfile} on sandbox, whatever pair
 * the shell holds. A live profile is the wrong dependency for a demo; the sandbox one in
 * particular expires between sessions. The UI-capture harness is the one exception: it runs vite
 * in its own mode and serves the profile it wants captured.
 */
export function demoBootInput(
  base: Record<string, string | undefined> = import.meta.env,
): Pick<ResolveBootConfigInput, "env" | "fetchImpl"> {
  if (base.MODE === "ui-capture") return { env: base }
  return {
    env: {
      ...base,
      VITE_NETWORK: "sandbox",
      VITE_CONFIG_PROFILE_URL: DEMO_PROFILE_URL,
      VITE_CONFIG_EXPECTED_PROFILE_ID: DEMO_PROFILE_ID,
    },
    fetchImpl: (async () =>
      new Response(JSON.stringify(demoProfile()), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch,
  }
}

import { WEB_PASSKEY_PRODUCTION_ORIGINS, WEB_PASSKEY_RP_IDS } from "@obsidion/core/constants"

export type WebPasskeyEnvironment = keyof typeof WEB_PASSKEY_RP_IDS
export type WebPasskeyEnv = {
  [key: string]: unknown
  VITE_PASSKEY_ENVIRONMENT?: string
  VITE_PASSKEY_RP_ID?: string
}

/** Deployment identity is independent of the wallet's selected chain. */
export function selectWebPasskeyRpId(env: WebPasskeyEnv): string {
  const environment = env.VITE_PASSKEY_ENVIRONMENT ?? "local"
  if (!Object.hasOwn(WEB_PASSKEY_RP_IDS, environment)) {
    throw new Error(`Unknown VITE_PASSKEY_ENVIRONMENT "${environment}"`)
  }
  const rpId = WEB_PASSKEY_RP_IDS[environment as WebPasskeyEnvironment]
  if (env.VITE_PASSKEY_RP_ID && env.VITE_PASSKEY_RP_ID !== rpId) {
    throw new Error(`VITE_PASSKEY_RP_ID "${env.VITE_PASSKEY_RP_ID}" conflicts with ${environment}: expected ${rpId}`)
  }
  return rpId
}

export function isRpDomainSuffix(hostname: string, rpId: string): boolean {
  return hostname === rpId || hostname.endsWith(`.${rpId}`)
}

/** Check both sides of a handoff before publishing either bundle. */
export function assertWebPasskeyBuild(
  env: WebPasskeyEnv & {
    VITE_SITE_ORIGIN?: string
    VITE_WALLET_URL?: string
    VITE_CAMPAIGN_URL?: string
  },
): string {
  const rpId = selectWebPasskeyRpId(env)
  // A prod-backed preview signs in against the production API, so its site origin is production's;
  // the handoff pair still has to sit under the preview RP.
  const prodBacked = env.VITE_PASSKEY_ENVIRONMENT === "prod-preview"
  for (const key of ["VITE_SITE_ORIGIN", "VITE_WALLET_URL", "VITE_CAMPAIGN_URL"] as const) {
    const value = env[key]
    if (!value) continue
    const url = new URL(value)
    const productionOrigin = (WEB_PASSKEY_PRODUCTION_ORIGINS as readonly string[]).includes(url.origin)
    const allowed =
      rpId === WEB_PASSKEY_RP_IDS.production
        ? productionOrigin
        : (isRpDomainSuffix(url.hostname, rpId) &&
            (url.protocol === "https:" || (rpId === "localhost" && url.protocol === "http:"))) ||
          (prodBacked && key === "VITE_SITE_ORIGIN" && productionOrigin)
    if (!allowed) throw new Error(`${key} (${url.origin}) cannot use the ${rpId} passkey RP`)
  }
  return rpId
}

/** Emit the selected RP so deployment checks do not search minified JavaScript. */
export function webPasskeyBuildPlugin(env: Parameters<typeof assertWebPasskeyBuild>[0]) {
  const rpId = assertWebPasskeyBuild(env)
  return {
    name: "web-passkey-target",
    generateBundle(this: { emitFile(asset: { type: "asset"; fileName: string; source: string }): unknown }) {
      this.emitFile({
        type: "asset",
        fileName: "passkey-target.json",
        source: JSON.stringify({ environment: env.VITE_PASSKEY_ENVIRONMENT ?? "local", rpId }),
      })
    },
  }
}

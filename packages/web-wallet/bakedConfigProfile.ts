import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import type { Plugin } from "vite"
import {
  ConfigProfileError,
  fetchConfigProfile,
  parseServedFeatures,
  parseServedProfile,
  resolveWalletProfileDocument,
  type ConfigProfile,
} from "@obsidion/config-client"
import { WalletError } from "@obsidion/core/errors"
import { assertProfilePolicy, parseNetwork } from "./src/config/profilePolicy.js"

/**
 * Bakes the config profile into the bundle so the wallet can boot when the config service is
 * unreachable. `vite build` reads `VITE_BAKED_CONFIG_PROFILE_FILE` byte for byte, the release's
 * own profile before it is published, or else fetches `VITE_CONFIG_PROFILE_URL`. It runs the
 * checks the wallet runs at boot (identity, network, `current`, the oxide-pointer policy), and
 * serves the result as `virtual:baked-config-profile`; the build fails if any of that fails. No
 * source, a profile id the store does not hold yet, or `vite dev`, bakes nothing.
 * `dist/build-target.json` records what was baked.
 */

export const BAKED_PROFILE_MODULE_ID = "virtual:baked-config-profile"
const RESOLVED_ID = "\0" + BAKED_PROFILE_MODULE_ID
export const BAKED_FEATURES_MODULE_ID = "virtual:baked-features"
const RESOLVED_FEATURES_ID = "\0" + BAKED_FEATURES_MODULE_ID

export interface BakedProfileStamp {
  profileId: string
  network: string
  current: string
  publishedAt: string
  /** The document's `expiresAt`; null when it never expires. */
  expiresAt: string | null
  /** `versions[current].gitSha`; null when the document carries none. */
  currentVersionGitSha: string | null
  /** SHA-256 of the exact JSON string the virtual module embeds. */
  sha256: string
}

export interface BakedProfile {
  /** The JSON the virtual module embeds. */
  payload: string
  stamp: BakedProfileStamp
}

type Env = Record<string, string | undefined>

/**
 * Load + validate + stamp, apart from the vite hooks so it can be tested without a build.
 * Returns undefined when the build sets no profile source.
 */
export async function bakeConfigProfile(
  env: Env,
  fetchImpl?: typeof fetch,
): Promise<BakedProfile | undefined> {
  const file = env.VITE_BAKED_CONFIG_PROFILE_FILE
  const source = file || env.VITE_CONFIG_PROFILE_URL
  if (!source) return undefined
  const expectedProfileId = env.VITE_CONFIG_EXPECTED_PROFILE_ID
  if (!expectedProfileId) {
    throw new Error(
      `${file ? "VITE_BAKED_CONFIG_PROFILE_FILE" : "VITE_CONFIG_PROFILE_URL"} is set but ` +
        "VITE_CONFIG_EXPECTED_PROFILE_ID is not — the baked profile cannot be checked against an " +
        "identity",
    )
  }
  const network = parseNetwork(env.VITE_NETWORK)
  let profile: ConfigProfile
  let payload: string
  if (file) {
    payload = readFileSync(file, "utf8")
    try {
      profile = parseServedProfile(JSON.parse(payload))
    } catch (e) {
      throw new Error(`${file}: ${(e as Error).message}`)
    }
  } else {
    const fetched = await fetchProfile(source, fetchImpl)
    if (!fetched) return undefined
    profile = fetched
    payload = JSON.stringify(profile)
  }
  const resolved = resolveWalletProfileDocument(profile, {
    source: `profile at ${source}`,
    expectedProfileId,
    network,
  })
  assertProfilePolicy(resolved, network)
  return {
    payload,
    stamp: {
      profileId: profile.profileId,
      network: profile.network,
      current: profile.current,
      publishedAt: profile.publishedAt,
      expiresAt: profile.expiresAt ?? null,
      currentVersionGitSha: resolved.version.gitSha ?? null,
      sha256: createHash("sha256").update(payload).digest("hex"),
    },
  }
}

async function fetchProfile(
  profileUrl: string,
  fetchImpl: typeof fetch | undefined,
): Promise<ConfigProfile | undefined> {
  try {
    return await fetchConfigProfile(profileUrl, { fetchImpl })
  } catch (e) {
    // A profile id the store has never held: a MANIFEST_AZTEC_VERSION bump, or a tier's first
    // stand-up. The baked copy only boots the wallet when the config service is unreachable, so
    // refusing to build for a fallback that cannot exist yet deadlocks the deploy that would
    // publish it. Every other failure still fails the build. This is build time only — at boot a
    // 404 stays fatal, because there a missing document means one that was torn down.
    if (e instanceof ConfigProfileError && e.code === "NOT_FOUND") {
      console.warn(
        `[bakedConfigProfile] ${profileUrl} does not exist yet — building with no baked profile`,
      )
      return undefined
    }
    throw new Error(`${profileUrl}: ${(e as Error).message}`)
  }
}

export interface BakedFeatures {
  payload: string
  stamp: { profileId: string; publishedAt: string | null; sha256: string }
}

/** Where the committed features documents are: `<profileId>.json`, as the store publishes them. */
export const COMMITTED_FEATURES_DIR = fileURLToPath(
  new URL("../backend/config-service/features/", import.meta.url),
)

/**
 * The committed features document of `VITE_CONFIG_EXPECTED_PROFILE_ID`, byte for byte, from the
 * build's own commit, with the checks the wallet runs at boot. A profile with no committed document
 * bakes nothing.
 */
export function bakeFeatures(env: Env, dir = COMMITTED_FEATURES_DIR): BakedFeatures | undefined {
  const profileId = env.VITE_CONFIG_EXPECTED_PROFILE_ID
  if (!profileId) return undefined
  const file = join(dir, `${profileId}.json`)
  if (!existsSync(file)) return undefined
  const payload = readFileSync(file, "utf8")
  const expected = { profileId, network: parseNetwork(env.VITE_NETWORK) }
  let served: ReturnType<typeof parseServedFeatures>
  try {
    served = parseServedFeatures(JSON.parse(payload), { expected })
  } catch (e) {
    throw new WalletError("config.invalid", `${file}: ${(e as Error).message}`, { cause: e })
  }
  const { document } = served
  return {
    payload,
    stamp: {
      profileId: document.profileId,
      publishedAt: document.publishedAt ?? null,
      sha256: createHash("sha256").update(payload).digest("hex"),
    },
  }
}

/**
 * The virtual module's source. `JSON.parse` of a string literal, never an object literal: `meta`
 * accepts arbitrary keys, and an own `__proto__` key in a literal would become the prototype.
 */
export function renderBakedProfileModule(payload: string | undefined): string {
  if (payload === undefined) return "export default undefined\n"
  return `export default JSON.parse(${JSON.stringify(payload)})\n`
}

export interface BakedConfigProfileOptions {
  fetchImpl?: typeof fetch
}

export function bakedConfigProfile(options: BakedConfigProfileOptions = {}): Plugin {
  let env: Env = {}
  let command: "build" | "serve" = "serve"
  let baked: BakedProfile | undefined
  let bakedFeatures: BakedFeatures | undefined

  return {
    name: "obsidion-baked-config-profile",
    configResolved(config) {
      env = config.env as Env
      command = config.command
    },
    async buildStart() {
      if (command !== "build") return
      try {
        baked = await bakeConfigProfile(env, options.fetchImpl)
      } catch (e) {
        throw new Error(`cannot bake the config profile: ${(e as Error).message}`)
      }
      try {
        bakedFeatures = bakeFeatures(env)
      } catch (e) {
        throw new WalletError(
          "config.invalid",
          `cannot bake the features document: ${(e as Error).message}`,
          { cause: e },
        )
      }
    },
    resolveId(id) {
      if (id === BAKED_PROFILE_MODULE_ID) return RESOLVED_ID
      if (id === BAKED_FEATURES_MODULE_ID) return RESOLVED_FEATURES_ID
    },
    load(id) {
      if (id === RESOLVED_ID) return renderBakedProfileModule(baked?.payload)
      if (id === RESOLVED_FEATURES_ID) return renderBakedProfileModule(bakedFeatures?.payload)
    },
    // What this build baked, so a deploy or an operator can see what a bundle carries.
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "build-target.json",
        source: JSON.stringify(
          {
            VITE_NETWORK: env.VITE_NETWORK ?? "",
            VITE_CONFIG_PROFILE_URL: env.VITE_CONFIG_PROFILE_URL ?? "",
            VITE_CONFIG_EXPECTED_PROFILE_ID: env.VITE_CONFIG_EXPECTED_PROFILE_ID ?? "",
            VITE_DESKTOP_BUILD: env.VITE_DESKTOP_BUILD ?? "",
            bakedProfile: baked?.stamp ?? null,
            bakedFeatures: bakedFeatures?.stamp ?? null,
          },
          null,
          2,
        ),
      })
    },
  }
}

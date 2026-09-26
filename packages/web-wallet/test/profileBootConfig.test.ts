// @vitest-environment node
/**
 * The boot path: `VITE_CONFIG_PROFILE_URL` names the profile that supplies the endpoints and the
 * contract snapshot, and the config it seeds is what every synchronous `getConfig()` consumer
 * reads.
 */
import { ZKJWT_VKEY_HASH } from "@obsidion/core/constants"
import { afterEach, describe, expect, it, vi } from "vitest"
import { fetchLiveProfilePortal, getConfig, resolveBootConfig } from "../src/config/env"
import { analyticsUrl } from "../src/lib/analytics"
import { F32, PORTAL, sandboxProfile, testnetProfile } from "./fixtures/sandboxProfile"

const PROFILE_URL = "http://localhost:8083/profiles/sandbox.json"
const PROFILE_ENV = {
  VITE_CONFIG_PROFILE_URL: PROFILE_URL,
  VITE_CONFIG_EXPECTED_PROFILE_ID: "sandbox",
}

function mainnetProfile() {
  const profile = sandboxProfile() as Record<string, any>
  profile.profileId = "mainnet"
  profile.network = "mainnet"
  delete profile.expiresAt
  // Mainnet refuses a pointer with no same-sha pin, so the fixture has to carry one.
  profile.versions["0.0.1"].oxide = {
    ...profile.versions["0.0.1"].oxide,
    expectedGitSha: "a".repeat(40),
  }
  profile.shared = { ...profile.shared, l1ChainId: 1 }
  profile.versions["0.0.1"] = {
    ...profile.versions["0.0.1"],
    nodeUrl: "https://node.example",
    l1RpcUrl: "https://l1.example",
    accountServiceUrl: "https://account.example",
    zkmoneyApiUrl: "https://api.example",
    paylinkDomain: "https://paylink.example",
  }
  profile.versions["0.0.1"].oxide.manifestUrl = "https://manifest.example/prod.v4.json"
  return profile
}

/** Mainnet refuses to build without screening; the oxide pointer comes from the document alone. */
const MAINNET_ENV = {
  VITE_NETWORK: "mainnet",
  VITE_PASSKEY_ENVIRONMENT: "production",
  VITE_PREDICATE_API_KEY: "key",
  VITE_PREDICATE_VERIFICATION_HASH: "x-managed-policy-abc",
  VITE_PREDICATE_CHAIN: "ethereum",
}

function serve(document: unknown, status = 200) {
  return vi.fn(async () => ({
    ok: status < 400,
    status,
    json: async () => document,
  })) as unknown as typeof fetch
}

function boot(
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch,
  runtime?: { nodeUrl?: string; l1RpcUrl?: string },
) {
  return resolveBootConfig({ env, fetchImpl, ...(runtime ? { runtime } : {}) })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("a missing profile URL", () => {
  it("is fatal before anything is fetched", async () => {
    const fetchImpl = serve(sandboxProfile())

    await expect(boot({}, fetchImpl)).rejects.toThrow(/VITE_CONFIG_PROFILE_URL/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("an expected profile id alone enables nothing", async () => {
    const fetchImpl = serve(sandboxProfile())

    await expect(boot({ VITE_CONFIG_EXPECTED_PROFILE_ID: "sandbox" }, fetchImpl)).rejects.toThrow(
      /VITE_CONFIG_PROFILE_URL/,
    )
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe("profile mode", () => {
  it("seeds the version + shared endpoints and hands the provider the snapshot", async () => {
    const fetchImpl = serve(sandboxProfile())
    const result = await boot(PROFILE_ENV, fetchImpl)

    expect(result.config.nodeUrl).toBe("http://profile-node.test")
    expect(result.config.l1RpcUrl).toBe("http://profile-l1.test")
    expect(result.config.accountServiceUrl).toBe("http://profile-account.test")
    expect(result.config.xmtpEnv).toBe("local")
    expect(getConfig()).toBe(result.config)

    expect(result.contractServiceOptions.source).toBe("profile")
    expect(result.contractServiceOptions.config?.contracts.paylinkDirect).toEqual({
      classId: F32(106),
    })
    expect(result.contractServiceOptions.resolveClassArtifact).toBeTypeOf("function")
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    await expect(result.contractServiceOptions.resolveClassArtifact!(F32(999))).rejects.toThrow(
      /has no artifact manifest pin/,
    )
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it("an explicitly-set VITE_* still wins over the profile", async () => {
    const result = await boot(
      {
        ...PROFILE_ENV,
        VITE_NODE_URL: "http://env-node.test",
        VITE_L1_RPC_URL: "http://env-l1.test",
        VITE_ACCOUNT_SERVICE_URL: "http://env-account.test",
        VITE_XMTP_ENV: "production",
      },
      serve(sandboxProfile()),
    )

    expect(result.config.nodeUrl).toBe("http://env-node.test")
    expect(result.config.l1RpcUrl).toBe("http://env-l1.test")
    expect(result.config.accountServiceUrl).toBe("http://env-account.test")
    expect(result.config.xmtpEnv).toBe("production")
  })

  it("leaves the analytics endpoint alone", async () => {
    const result = await boot(PROFILE_ENV, serve(sandboxProfile()))

    // Read from `import.meta.env` at module scope, so the profile has no way to reach it.
    expect(analyticsUrl).toBeUndefined()
    expect(result.config).not.toHaveProperty("zkmoneyApiUrl")
  })

  it("makes the version pointer the one oxide authority", async () => {
    const result = await boot(PROFILE_ENV, serve(sandboxProfile()))

    const pointer = { manifestUrl: "http://profile-oxide.test/sandbox.json", portal: PORTAL }
    expect(result.config.oxideProfile).toEqual(pointer)
    expect(result.contractServiceOptions.oxideEnvProfile).toEqual(pointer)
    expect(result.contractServiceOptions.config?.oxide).toEqual(pointer)
  })

  it("VITE_OXIDE_* env keys do not move the pointer", async () => {
    const result = await boot(
      {
        ...PROFILE_ENV,
        VITE_OXIDE_MANIFEST_URL: "http://env-oxide.test/dev.json",
        VITE_OXIDE_PORTAL: "0x" + "1".repeat(40),
        VITE_OXIDE_EXPECTED_GIT_SHA: "f".repeat(40),
      },
      serve(sandboxProfile()),
    )

    const pointer = { manifestUrl: "http://profile-oxide.test/sandbox.json", portal: PORTAL }
    expect(result.config.oxideProfile).toEqual(pointer)
    expect(result.contractServiceOptions.oxideEnvProfile).toEqual(pointer)
  })
})

describe("boot failures are fatal — never a silent registry fallback", () => {
  it("a fetch failure", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("connection refused")
    }) as unknown as typeof fetch

    await expect(boot(PROFILE_ENV, fetchImpl)).rejects.toThrow(/profile fetch failed/)
  })

  it("a 404 — a torn-down profile", async () => {
    await expect(boot(PROFILE_ENV, serve({}, 404))).rejects.toThrow(/profile not found/)
  })

  it("a mainnet document with no same-sha pin — the schema refuses it", async () => {
    const env = { ...MAINNET_ENV, ...PROFILE_ENV, VITE_CONFIG_EXPECTED_PROFILE_ID: "mainnet" }
    const doc = mainnetProfile() as Record<string, any>
    delete doc.versions["0.0.1"].oxide.expectedGitSha

    await expect(boot(env, serve(doc))).rejects.toThrow(/oxide\.expectedGitSha/)
  })

  it("a mainnet document boots — the version supplies the pointer loadConfig cannot bake", async () => {
    const env = { ...MAINNET_ENV, ...PROFILE_ENV, VITE_CONFIG_EXPECTED_PROFILE_ID: "mainnet" }
    const doc = mainnetProfile() as Record<string, any>
    doc.shared.rollupVersion = "999999999"

    const result = await boot(env, serve(doc))
    expect(result.config.nodeUrl).toBe("https://node.example")
    expect(result.config.oxideProfile.expectedGitSha).toBe("a".repeat(40))
    expect(result.contractServiceOptions.source).toBe("profile")
  })

  it("any rollupVersion boots — the profile id is what binds a build to a document", async () => {
    for (const rollupVersion of ["3685977955", "1821665230", "999999999"]) {
      const doc = sandboxProfile() as Record<string, any>
      doc.shared.rollupVersion = rollupVersion

      const result = await boot(PROFILE_ENV, serve(doc))
      expect(result.contractServiceOptions.source, `rollup ${rollupVersion}`).toBe("profile")
    }
  })

  it("a dev manifest on a durable network", async () => {
    const env = {
      ...PROFILE_ENV,
      VITE_NETWORK: "testnet",
      VITE_CONFIG_EXPECTED_PROFILE_ID: "staging",
    }
    const doc = sandboxProfile() as Record<string, any>
    doc.profileId = "staging"
    doc.network = "testnet"
    doc.shared.l1ChainId = 11155111
    doc.versions["0.0.1"] = {
      ...doc.versions["0.0.1"],
      nodeUrl: "https://node.example",
      l1RpcUrl: "https://l1.example",
      accountServiceUrl: "https://account.example",
      zkmoneyApiUrl: "https://api.example",
      paylinkDomain: "https://paylink.example",
      oxide: {
        ...doc.versions["0.0.1"].oxide,
        manifestUrl: "https://manifest.example/dev.v4.json",
      },
    }

    await expect(boot(env, serve(doc))).rejects.toThrow(/dev or local manifest/)
    doc.versions["0.0.1"].oxide.manifestUrl = "https://manifest.example/dev.v4.json?cache=1"
    await expect(boot(env, serve(doc))).rejects.toThrow(/dev or local manifest/)
  })

  it("a document identifying as something else", async () => {
    const env = { ...PROFILE_ENV, VITE_CONFIG_EXPECTED_PROFILE_ID: "testnet" }

    await expect(boot(env, serve(sandboxProfile()))).rejects.toThrow(/identifies as "sandbox"/)
  })

  it("a profile URL with no expected id", async () => {
    const env = { VITE_CONFIG_PROFILE_URL: PROFILE_URL }

    await expect(boot(env, serve(sandboxProfile()))).rejects.toThrow(/expected profile id/)
  })
})

/**
 * `vercel-build-deploy.sh` writes every allow-listed key into `.env.production` whether or not the
 * operator set it, so a deployed bundle sees `""` where a test would naturally pass `undefined`.
 */
describe("a deployed bundle's empty-string env", () => {
  const DEPLOYED = {
    ...PROFILE_ENV,
    VITE_NODE_URL: "",
    VITE_L1_RPC_URL: "",
    VITE_ACCOUNT_SERVICE_URL: "",
  }

  it("takes the profile's endpoints, not the empty strings", async () => {
    const result = await boot(DEPLOYED, serve(sandboxProfile()))

    expect(result.config.nodeUrl).toBe("http://profile-node.test")
    expect(result.config.l1RpcUrl).toBe("http://profile-l1.test")
    expect(result.config.oxideProfile.manifestUrl).toBe("http://profile-oxide.test/sandbox.json")
  })

  it("still lets a genuinely-set var win", async () => {
    const result = await boot(
      { ...DEPLOYED, VITE_NODE_URL: "http://operator-node.test" },
      serve(sandboxProfile()),
    )

    expect(result.config.nodeUrl).toBe("http://operator-node.test")
  })
})

/**
 * The document baked into the bundle answers exactly one failure: the config service never
 * answered. Everything the server says — a 404 above all — stays fatal.
 */
describe("the baked profile", () => {
  const unreachable = vi.fn(async () => {
    throw new TypeError("fetch failed")
  }) as unknown as typeof fetch

  function bakedDoc() {
    const doc = sandboxProfile()
    doc.publishedAt = "2026-08-01T00:00:00.000Z"
    doc.versions["0.0.1"].nodeUrl = "http://baked-node.test"
    return doc
  }

  it("is ignored while the live document resolves", async () => {
    const result = await resolveBootConfig({
      env: PROFILE_ENV,
      fetchImpl: serve(sandboxProfile()),
      bakedProfile: bakedDoc(),
    })
    expect(result.config.nodeUrl).toBe("http://profile-node.test")
    expect(result.bootedFromBakedProfile).toBe(false)
    expect(result.bakedProfile).toBeUndefined()
  })

  it("boots the wallet when the service is unreachable, and says so", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const result = await resolveBootConfig({
      env: PROFILE_ENV,
      fetchImpl: unreachable,
      bakedProfile: bakedDoc(),
    })

    expect(result.config.nodeUrl).toBe("http://baked-node.test")
    expect(result.contractServiceOptions.source).toBe("profile")
    expect(result.bootedFromBakedProfile).toBe(true)
    expect(result.bakedProfile).toEqual({
      publishedAt: "2026-08-01T00:00:00.000Z",
      current: "0.0.1",
      liveFailure: { code: "UNREACHABLE", message: expect.stringContaining("fetch failed") },
    })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("fetch failed"))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("2026-08-01T00:00:00.000Z"))
  })

  it("a host-injected endpoint still outranks the snapshot's", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const result = await resolveBootConfig({
      env: PROFILE_ENV,
      fetchImpl: unreachable,
      bakedProfile: bakedDoc(),
      runtime: { nodeUrl: "http://desktop-node.test" },
    })
    expect(result.config.nodeUrl).toBe("http://desktop-node.test")
  })

  it("a 404 stays fatal — the server answered", async () => {
    await expect(
      resolveBootConfig({ env: PROFILE_ENV, fetchImpl: serve({}, 404), bakedProfile: bakedDoc() }),
    ).rejects.toThrow(/profile not found/)
  })

  it("a snapshot the wallet's own policy refuses is fatal", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const doc = testnetProfile()
    doc.versions["0.0.1"].oxide.manifestUrl = "https://manifest.example/dev.v4.json"
    const env = {
      ...PROFILE_ENV,
      VITE_NETWORK: "testnet",
      VITE_CONFIG_EXPECTED_PROFILE_ID: "staging-v5",
    }
    await expect(
      resolveBootConfig({ env, fetchImpl: unreachable, bakedProfile: doc }),
    ).rejects.toThrow(/dev or local manifest/)
  })
})

describe("degradations", () => {
  it("a profile for another network is fatal", async () => {
    const profile = sandboxProfile() as Record<string, any>
    profile.network = "testnet"
    profile.shared.l1ChainId = 11155111
    // Every network but sandbox demands https, and this document must still parse.
    profile.versions["0.0.1"] = {
      ...profile.versions["0.0.1"],
      nodeUrl: "https://node.example",
      l1RpcUrl: "https://l1.example",
      accountServiceUrl: "https://account.example",
      zkmoneyApiUrl: "https://api.example",
      paylinkDomain: "https://paylink.example",
      oxide: {
        ...profile.versions["0.0.1"].oxide,
        manifestUrl: "https://manifest.example/staging.v4.json",
      },
    }

    await expect(boot(PROFILE_ENV, serve(profile))).rejects.toThrow(/is for network "testnet"/)
  })

  // The desktop launcher injects the user's saved endpoints into the page. Profile boot is
  // mandatory, so a merge that let the profile win would make that settings screen inert.
  it("a host-injected endpoint outranks the profile's", async () => {
    const result = await boot(PROFILE_ENV, serve(sandboxProfile()), {
      nodeUrl: "http://desktop-node.test",
      l1RpcUrl: "http://desktop-l1.test",
    })

    expect(result.config.nodeUrl).toBe("http://desktop-node.test")
    expect(result.config.l1RpcUrl).toBe("http://desktop-l1.test")
  })

  it("the profile supplies the endpoints no host override names", async () => {
    const result = await boot(PROFILE_ENV, serve(sandboxProfile()), {
      nodeUrl: "http://desktop-node.test",
    })

    expect(result.config.nodeUrl).toBe("http://desktop-node.test")
    expect(result.config.l1RpcUrl).toBe("http://profile-l1.test")
  })

  it("vkey skew is reported and boot proceeds", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    const profile = sandboxProfile()
    profile.versions["0.0.1"].vkeys.zkJwtVkeyHash = F32(7)

    const result = await boot(PROFILE_ENV, serve(profile))

    expect(result.zkJwtVkeySkew).toBe(true)
    expect(result.config.nodeUrl).toBe("http://profile-node.test")
    expect(error).toHaveBeenCalledWith(expect.stringContaining(F32(7)))
    expect(error).toHaveBeenCalledWith(expect.stringContaining(ZKJWT_VKEY_HASH))
  })
})

describe("fetchLiveProfilePortal", () => {
  const NEW_PORTAL = "0x" + "77".repeat(20)

  function repointed() {
    const doc = sandboxProfile() as Record<string, any>
    doc.versions["0.0.1"].oxide = { ...doc.versions["0.0.1"].oxide, portal: NEW_PORTAL }
    return doc
  }

  it("re-reads the profile with the boot's expectations and returns the portal it pins now", async () => {
    await boot(PROFILE_ENV, serve(sandboxProfile()))
    expect(getConfig().oxideProfile.portal).toBe(PORTAL)
    const live = serve(repointed())
    await expect(fetchLiveProfilePortal(live)).resolves.toBe(NEW_PORTAL)
    expect(live).toHaveBeenCalledWith(PROFILE_URL, expect.anything())
    expect(getConfig().oxideProfile.portal).toBe(PORTAL)
  })

  it("applies the identity check, so a wrong document never reports a repoint", async () => {
    await boot(PROFILE_ENV, serve(sandboxProfile()))
    const wrong = repointed()
    wrong.profileId = "other"
    await expect(fetchLiveProfilePortal(serve(wrong))).rejects.toThrow(/identifies as "other"/)
  })

  it("throws before boot", async () => {
    vi.resetModules()
    const fresh = await import("../src/config/env")
    await expect(fresh.fetchLiveProfilePortal(serve(sandboxProfile()))).rejects.toThrow(
      /before resolveBootConfig/,
    )
  })
})

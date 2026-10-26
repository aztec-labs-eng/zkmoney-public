import { describe, expect, it } from "vitest"
import {
  ProfileNetworkMismatchError,
  WalletProfileError,
  resolveWalletProfile,
  resolveWalletProfileDocument,
} from "../src/walletProfile.js"
import { parseConfigProfile } from "../src/schema.js"
import { stagingDoc } from "./fixture.js"

const PROFILE_URL = "https://config.example/profiles/staging-v5.json"
const VKEY_HASH = "0x" + (200).toString(16).padStart(64, "0")

function fetchDoc(doc: unknown): typeof fetch {
  return async () =>
    new Response(JSON.stringify(doc), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
}

function fetchDocs(docs: Record<string, unknown>): typeof fetch {
  return async (input) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    const doc = docs[url]
    return doc === undefined
      ? new Response("not found", { status: 404 })
      : new Response(JSON.stringify(doc), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
  }
}

function singleVersionProfile(
  source: any,
  profileId: string,
  versionId: string,
  nodeUrl: string,
): any {
  const version = structuredClone(source.versions[source.current])
  version.nodeUrl = nodeUrl
  return {
    ...structuredClone(source),
    profileId,
    current: versionId,
    versions: { [versionId]: version },
  }
}

const refuseFetch: typeof fetch = async () => {
  throw new Error("fetch must not be called")
}

function input(overrides: Partial<Parameters<typeof resolveWalletProfile>[0]> = {}) {
  return {
    profileUrl: PROFILE_URL,
    expectedProfileId: "staging-v5",
    network: "testnet",
    fetchImpl: fetchDoc(stagingDoc()),
    ...overrides,
  }
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (e) {
    return e
  }
  throw new Error("expected rejection")
}

describe("resolveWalletProfile", () => {
  it("resolves the live version into a snapshot", async () => {
    const boot = await resolveWalletProfile(input({ expectedZkJwtVkeyHash: VKEY_HASH }))

    expect(boot.versionId).toBe("0.0.2")
    expect(boot.nodeUrl).toBe("https://node.example")
    expect(boot.profile.profileId).toBe("staging-v5")
    expect(boot.snapshot.network).toBe("testnet")
    expect(boot.snapshot.contracts.oidcKeyRegistry?.address).toBe(
      boot.version.contracts.oidcKeyRegistry?.address,
    )
    expect(boot.snapshot.oxide?.manifestUrl).toBe("https://manifest.example/staging.v4.json")
    expect(boot.zkJwtVkeySkew).toBe(false)
  })

  it("reports no skew when the version carries no vkeys", async () => {
    const doc = stagingDoc()
    delete doc.versions["0.0.2"].vkeys

    const boot = await resolveWalletProfile(
      input({ fetchImpl: fetchDoc(doc), expectedZkJwtVkeyHash: VKEY_HASH }),
    )
    expect(boot.version.vkeys).toBeUndefined()
    expect(boot.zkJwtVkeySkew).toBe(false)
  })

  it("reports no skew when the caller bakes no hash", async () => {
    const boot = await resolveWalletProfile(input())
    expect(boot.zkJwtVkeySkew).toBe(false)
  })

  it("compares vkey hashes case-insensitively", async () => {
    const doc = stagingDoc()
    doc.versions["0.0.2"].vkeys.zkJwtVkeyHash = VKEY_HASH.toUpperCase().replace("0X", "0x")

    const boot = await resolveWalletProfile(
      input({ fetchImpl: fetchDoc(doc), expectedZkJwtVkeyHash: VKEY_HASH }),
    )
    expect(boot.zkJwtVkeySkew).toBe(false)
  })

  it("flags vkey skew without throwing", async () => {
    const boot = await resolveWalletProfile(
      input({ expectedZkJwtVkeyHash: "0x" + (201).toString(16).padStart(64, "0") }),
    )
    expect(boot.zkJwtVkeySkew).toBe(true)
  })

  it("refuses a profile scoped to another rollup", async () => {
    const error = await rejection(resolveWalletProfile(input({ expectedRollupVersion: "999" })))
    expect(error).toBeInstanceOf(WalletProfileError)
    expect((error as WalletProfileError).code).toBe("UNSUPPORTED_VERSION")
    expect((error as Error).message).toContain("An app update is required")
  })

  it("adopts the profile when the expected rollup matches", async () => {
    const boot = await resolveWalletProfile(input({ expectedRollupVersion: "1821665230" }))
    expect(boot.versionId).toBe("0.0.2")
  })

  it("names both ids when the document is not the expected profile", async () => {
    const error = await rejection(resolveWalletProfile(input({ expectedProfileId: "mainnet" })))
    expect(error).toBeInstanceOf(WalletProfileError)
    expect((error as WalletProfileError).code).toBe("IDENTITY_MISMATCH")
    expect((error as Error).message).toContain("staging-v5")
    expect((error as Error).message).toContain("mainnet")
  })

  it("raises a distinct, catchable type when the network differs", async () => {
    const error = await rejection(resolveWalletProfile(input({ network: "mainnet" })))
    expect(error).toBeInstanceOf(ProfileNetworkMismatchError)
    expect((error as ProfileNetworkMismatchError).profileNetwork).toBe("testnet")
    expect((error as ProfileNetworkMismatchError).activeNetwork).toBe("mainnet")
  })

  it("treats a wrong document as fatal even when its network also differs", async () => {
    const doc = stagingDoc()
    doc.profileId = "someone-elses"

    const error = await rejection(
      resolveWalletProfile(input({ fetchImpl: fetchDoc(doc), network: "mainnet" })),
    )
    expect(error).not.toBeInstanceOf(ProfileNetworkMismatchError)
    expect((error as WalletProfileError).code).toBe("IDENTITY_MISMATCH")
  })

  it("fails before fetching when either identity input is missing", async () => {
    for (const missing of [{ profileUrl: undefined }, { expectedProfileId: undefined }]) {
      const error = await rejection(
        resolveWalletProfile(input({ ...missing, fetchImpl: refuseFetch })),
      )
      expect(error).toBeInstanceOf(WalletProfileError)
      expect((error as WalletProfileError).code).toBe("MISSING_CONFIG")
    }
  })
})

describe("previous-generation profiles", () => {
  const V5_URL = "https://config.example/profiles/v5/0.0.2.json"
  const V6_VERSION_URL = "https://config.example/profiles/v6/0.1.0.json"
  const V6_CURRENT_URL = "https://config.example/profiles/v6/current.json"

  it("walks previous-generation URLs", async () => {
    const v5 = singleVersionProfile(stagingDoc(), "staging-v5", "0.0.2", "https://v5-node.example")
    v5.versions["0.0.2"].artifactManifestSha256 = "a".repeat(64)
    const v6 = singleVersionProfile(v5, "staging-v6", "0.1.0", "https://v6-node.example")
    v6.shared.previousGenerationProfile = V5_URL
    const current = singleVersionProfile(v6, "staging-v7", "0.1.0", "https://v7-node.example")
    current.shared.previousGenerationProfile = V6_VERSION_URL

    const boot = await resolveWalletProfile({
      profileUrl: V6_CURRENT_URL,
      expectedProfileId: "staging-v7",
      network: "testnet",
      fetchImpl: fetchDocs({
        [V6_CURRENT_URL]: current,
        [V6_VERSION_URL]: v6,
        [V5_URL]: v5,
      }),
    })

    expect(boot.sourceRollups.map(({ nodeUrl }) => nodeUrl)).toEqual([
      "https://v6-node.example",
      "https://v5-node.example",
    ])
    expect(boot.sourceRollups[0]?.contracts.contracts.claimFpc?.address).toBe(
      v6.versions[v6.current].contracts.claimFpc.address,
    )
    // The generation's bundle reads retired classes, a payment link's among them, from this manifest.
    expect(boot.sourceRollups[1]?.artifacts).toEqual({
      profileUrl: V5_URL,
      profileId: "staging-v5",
      versionId: "0.0.2",
      expectedSha256: "a".repeat(64),
    })
  })

  it("preserves every portal pin when historical generations share a node", async () => {
    const olderUrl = "https://config.example/profiles/v5/0.1.0.json"
    const newerUrl = "https://config.example/profiles/v6/0.2.0.json"
    const olderPortal = `0x${"11".repeat(20)}`
    const newerPortal = `0x${"22".repeat(20)}`
    const sourceNode = "https://v6-node.example"
    const setPortal = (profile: any, portal: string) => {
      profile.versions[profile.current].oxide.portal = portal
      return profile
    }

    const older = setPortal(
      singleVersionProfile(stagingDoc(), "staging-v5", "0.1.0", sourceNode),
      olderPortal,
    )
    const newer = setPortal(
      singleVersionProfile(stagingDoc(), "staging-v6", "0.2.0", sourceNode),
      newerPortal,
    )
    newer.shared.previousGenerationProfile = olderUrl
    const current = singleVersionProfile(
      stagingDoc(),
      "staging-v7",
      "0.1.0",
      "https://v7-node.example",
    )
    current.shared.previousGenerationProfile = newerUrl

    const boot = await resolveWalletProfile({
      profileUrl: V6_CURRENT_URL,
      expectedProfileId: "staging-v7",
      network: "testnet",
      fetchImpl: fetchDocs({
        [V6_CURRENT_URL]: current,
        [newerUrl]: newer,
        [olderUrl]: older,
      }),
    })

    expect(boot.sourceRollups).toHaveLength(2)
    expect(boot.sourceRollups.map((source) => source.nodeUrl)).toEqual([sourceNode, sourceNode])
    expect(boot.sourceRollups.flatMap((source) => source.pins.map((pin) => pin.portal))).toEqual([
      newerPortal,
      olderPortal,
    ])
  })

  it.each([
    ["is missing", undefined, "NOT_FOUND"],
    ["is invalid", { nope: true }, "INVALID_PROFILE"],
  ])("boots without a historical profile that %s", async (_case, historical, code) => {
    const v5 = singleVersionProfile(stagingDoc(), "staging-v5", "0.0.2", "https://v5-node.example")
    const v6 = singleVersionProfile(v5, "staging-v6", "0.1.0", "https://v6-node.example")
    v6.shared.previousGenerationProfile = V5_URL
    const docs = {
      [V6_CURRENT_URL]: v6,
      ...(historical === undefined ? {} : { [V5_URL]: historical }),
    }

    const boot = await resolveWalletProfile({
      profileUrl: V6_CURRENT_URL,
      expectedProfileId: "staging-v6",
      network: "testnet",
      fetchImpl: fetchDocs(docs),
    })

    expect(boot.versionId).toBe("0.1.0")
    expect(boot.sourceRollups).toEqual([])
    expect(boot.sourceRollupIssues).toMatchObject([{ code }])
  })

  it("boots when a historical profile is unreachable", async () => {
    const v5 = singleVersionProfile(stagingDoc(), "staging-v5", "0.0.2", "https://v5-node.example")
    const v6 = singleVersionProfile(v5, "staging-v6", "0.1.0", "https://v6-node.example")
    v6.shared.previousGenerationProfile = V5_URL
    const liveFetch = fetchDocs({ [V6_CURRENT_URL]: v6 })
    const fetchImpl: typeof fetch = async (request, init) => {
      const url =
        typeof request === "string"
          ? request
          : request instanceof URL
          ? request.toString()
          : request.url
      if (url === V5_URL) throw new TypeError("connection refused")
      return liveFetch(request, init)
    }

    const boot = await resolveWalletProfile({
      profileUrl: V6_CURRENT_URL,
      expectedProfileId: "staging-v6",
      network: "testnet",
      fetchImpl,
    })

    expect(boot.versionId).toBe("0.1.0")
    expect(boot.sourceRollupIssues).toMatchObject([
      { code: "UNREACHABLE", message: expect.stringContaining("connection refused") },
    ])
  })
})

/**
 * The snapshot a build bakes in answers exactly one failure — the server never answered — and
 * runs every check a served document runs.
 */
describe("a baked snapshot", () => {
  /** The same document pinned one version back, so a test can tell which copy booted. */
  function bakedDoc() {
    const doc = stagingDoc()
    doc.current = "0.0.1"
    return doc
  }

  const unreachable: typeof fetch = async () => {
    throw new TypeError("fetch failed")
  }
  const answering = (status: number): typeof fetch =>
    (async () => ({ ok: false, status, json: async () => ({}) })) as unknown as typeof fetch

  it("is ignored while the live document resolves", async () => {
    const boot = await resolveWalletProfile(input({ bakedProfile: bakedDoc() }))
    expect(boot.versionId).toBe("0.0.2")
    expect(boot.bootedFromBakedProfile).toBe(false)
    expect(boot.liveFailure).toBeUndefined()
  })

  it("boots the wallet when the fetch throws, naming the live failure", async () => {
    const boot = await resolveWalletProfile(
      input({ fetchImpl: unreachable, bakedProfile: bakedDoc() }),
    )
    expect(boot.versionId).toBe("0.0.1")
    expect(boot.bootedFromBakedProfile).toBe(true)
    expect(boot.liveFailure).toMatchObject({ code: "UNREACHABLE" })
    expect(boot.liveFailure?.message).toContain("fetch failed")
    expect(boot.nodeUrl).toBe("https://v1-node.example")
  })

  it("boots the wallet on a 5xx", async () => {
    const boot = await resolveWalletProfile(
      input({ fetchImpl: answering(503), bakedProfile: bakedDoc() }),
    )
    expect(boot.bootedFromBakedProfile).toBe(true)
    expect(boot.liveFailure?.message).toContain("503")
  })

  it("boots the wallet when the server never answers", async () => {
    const hangs: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))
      })
    const boot = await resolveWalletProfile(
      input({ fetchImpl: hangs, timeoutMs: 5, bakedProfile: bakedDoc() }),
    )
    expect(boot.bootedFromBakedProfile).toBe(true)
    expect(boot.liveFailure?.message).toContain("no complete response within 5ms")
  })

  it.each([
    [404, "NOT_FOUND"],
    [403, "HTTP_ERROR"],
  ])("never answers a %i — the server spoke", async (status, code) => {
    const e = await rejection(
      resolveWalletProfile(input({ fetchImpl: answering(status), bakedProfile: bakedDoc() })),
    )
    expect(e).toMatchObject({ name: "ConfigProfileError", code })
  })

  it("never answers a live document that fails its own checks", async () => {
    const expired = stagingDoc()
    expired.expiresAt = "2026-08-12T00:00:00.000Z"
    const now = () => new Date("2026-09-01T00:00:00Z")
    expect(
      await rejection(
        resolveWalletProfile(
          input({ fetchImpl: fetchDoc(expired), now, bakedProfile: bakedDoc() }),
        ),
      ),
    ).toMatchObject({ code: "EXPIRED" })

    expect(
      await rejection(
        resolveWalletProfile(
          input({ fetchImpl: fetchDoc({ profileId: "x" }), bakedProfile: bakedDoc() }),
        ),
      ),
    ).toMatchObject({ code: "INVALID_PROFILE" })

    expect(
      await rejection(
        resolveWalletProfile(input({ expectedProfileId: "mainnet", bakedProfile: bakedDoc() })),
      ),
    ).toMatchObject({ code: "IDENTITY_MISMATCH" })

    expect(
      await rejection(
        resolveWalletProfile(input({ network: "mainnet", bakedProfile: bakedDoc() })),
      ),
    ).toBeInstanceOf(ProfileNetworkMismatchError)
  })

  it("changes nothing when no snapshot was baked", async () => {
    const e = await rejection(resolveWalletProfile(input({ fetchImpl: unreachable })))
    expect(e).toMatchObject({
      code: "UNREACHABLE",
      message: expect.stringContaining("fetch failed"),
    })
  })

  describe("forced", () => {
    const now = () => new Date("2026-09-01T00:00:00Z")

    it("boots the snapshot without fetching", async () => {
      const boot = await resolveWalletProfile(
        input({ fetchImpl: refuseFetch, bakedProfile: bakedDoc(), forceBakedProfile: true }),
      )
      expect(boot.versionId).toBe("0.0.1")
      expect(boot.bootedFromBakedProfile).toBe(true)
      expect(boot.liveFailure).toBeUndefined()
      expect(boot.bakedProfileExpired).toBe(false)
    })

    it("boots an expired snapshot and says so", async () => {
      const stale = bakedDoc()
      stale.expiresAt = "2026-08-12T00:00:00.000Z"
      const boot = await resolveWalletProfile(
        input({ fetchImpl: refuseFetch, now, bakedProfile: stale, forceBakedProfile: true }),
      )
      expect(boot.bootedFromBakedProfile).toBe(true)
      expect(boot.bakedProfileExpired).toBe(true)
    })

    it("still refuses the wrong document", async () => {
      expect(
        await rejection(
          resolveWalletProfile(
            input({
              expectedProfileId: "mainnet",
              bakedProfile: bakedDoc(),
              forceBakedProfile: true,
            }),
          ),
        ),
      ).toMatchObject({ code: "IDENTITY_MISMATCH" })
      expect(
        await rejection(
          resolveWalletProfile(
            input({ network: "mainnet", bakedProfile: bakedDoc(), forceBakedProfile: true }),
          ),
        ),
      ).toBeInstanceOf(ProfileNetworkMismatchError)
    })

    it("fails when the build baked nothing", async () => {
      const e = await rejection(resolveWalletProfile(input({ forceBakedProfile: true })))
      expect(e).toMatchObject({ name: "WalletProfileError", code: "MISSING_CONFIG" })
    })
  })

  it("rejects an expired snapshot, naming the live failure too", async () => {
    const stale = bakedDoc()
    stale.expiresAt = "2026-08-12T00:00:00.000Z"
    const e = await rejection(
      resolveWalletProfile(
        input({
          fetchImpl: unreachable,
          now: () => new Date("2026-09-01T00:00:00Z"),
          bakedProfile: stale,
        }),
      ),
    )
    expect(e).toMatchObject({ code: "EXPIRED" })
    expect((e as Error).message).toContain("live profile unreachable")
    expect((e as Error).message).toContain("fetch failed")
  })

  it("rejects a snapshot for another profile", async () => {
    const foreign = bakedDoc()
    foreign.profileId = "someone-elses"
    const e = await rejection(
      resolveWalletProfile(input({ fetchImpl: unreachable, bakedProfile: foreign })),
    )
    expect(e).toMatchObject({ code: "IDENTITY_MISMATCH" })
    expect((e as Error).message).toContain("the baked profile")
  })

  it("rejects a snapshot on another rollup when the build binds one", async () => {
    const e = await rejection(
      resolveWalletProfile(
        input({ fetchImpl: unreachable, bakedProfile: bakedDoc(), expectedRollupVersion: "999" }),
      ),
    )
    expect(e).toMatchObject({ code: "UNSUPPORTED_VERSION" })
  })

  it("rejects a malformed snapshot", async () => {
    const e = await rejection(
      resolveWalletProfile(input({ fetchImpl: unreachable, bakedProfile: { nope: 1 } })),
    )
    expect(e).toMatchObject({ code: "INVALID_PROFILE" })
  })

  it("prunes keys the snapshot carries that this build predates", async () => {
    const doc = bakedDoc()
    doc.futureKey = true
    const boot = await resolveWalletProfile(input({ fetchImpl: unreachable, bakedProfile: doc }))
    expect(boot.bootedFromBakedProfile).toBe(true)
    expect(boot.profile).not.toHaveProperty("futureKey")
  })
})

describe("resolveWalletProfileDocument", () => {
  it("resolves a parsed document with no fetch at all", () => {
    const resolved = resolveWalletProfileDocument(parseConfigProfile(stagingDoc()), {
      source: "a test document",
      expectedProfileId: "staging-v5",
      network: "testnet",
    })
    expect(resolved.versionId).toBe("0.0.2")
    expect(resolved).not.toHaveProperty("bootedFromBakedProfile")
  })

  it("names the caller's source in an identity failure", () => {
    expect(() =>
      resolveWalletProfileDocument(parseConfigProfile(stagingDoc()), {
        source: "a test document",
        expectedProfileId: "mainnet",
        network: "testnet",
      }),
    ).toThrow(/a test document identifies as "staging-v5"/)
  })
})

describe("a current entry the build cannot read", () => {
  it("fails boot with the typed app-update error, not a parse failure", async () => {
    const doc = stagingDoc()
    doc.versions["0.0.3"] = { schemaVersion: "2" }
    doc.current = "0.0.3"
    const e = await rejection(resolveWalletProfile(input({ fetchImpl: fetchDoc(doc) })))
    expect(e).toMatchObject({ name: "ConfigProfileError", code: "UNSUPPORTED_VERSION_SCHEMA" })
    expect((e as Error).message).toContain("app update")
  })
})

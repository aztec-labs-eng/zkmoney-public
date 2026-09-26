import { createHash } from "node:crypto"
import { describe, expect, it, vi } from "vitest"
import {
  artifactBlobUrl,
  artifactManifestUrl,
  createArtifactPinResolver,
  fetchArtifactManifest,
  parseArtifactManifest,
} from "../src/artifactManifest.js"

const PROFILE_ID = "prod-v5"
const VERSION_ID = "0.5.1"
const CLASS_ID = `0x${"1".repeat(64)}`
const ARTIFACT_SHA = "2".repeat(64)

const manifest = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: "1",
  profileId: PROFILE_ID,
  versionId: VERSION_ID,
  classes: {
    [CLASS_ID]: {
      name: "sipaBroadcaster",
      artifact: {
        url: `https://cdn.zk.money/artifacts/v5/${ARTIFACT_SHA}.json`,
        sha256: ARTIFACT_SHA,
      },
    },
  },
  ...overrides,
})

const bytes = (value: unknown) => JSON.stringify(value)
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex")

describe("artifactManifestUrl", () => {
  it.each([
    [
      "https://cdn.zk.money/profiles/v5/current.json",
      "https://cdn.zk.money/artifacts/v5/0.5.1.json",
    ],
    [
      "https://cdn.staging.zk.money/profiles/v5/0.5.1.json",
      "https://cdn.staging.zk.money/artifacts/v5/0.5.1.json",
    ],
  ])("derives the versioned manifest from %s", (profileUrl, expected) => {
    expect(artifactManifestUrl(profileUrl, VERSION_ID)).toBe(expected)
  })

  it.each([
    "https://cdn.zk.money/profiles/prod-v5.json",
    "https://cdn.zk.money/profiles/v5/0.5.0.json",
    "https://user:secret@cdn.zk.money/profiles/v5/current.json",
    "https://cdn.zk.money/profiles/v5/current.json?cache=1",
    "http://cdn.zk.money/profiles/v5/current.json",
  ])("rejects an unexpected profile URL instead of guessing: %s", (profileUrl) => {
    expect(() => artifactManifestUrl(profileUrl, VERSION_ID)).toThrow()
  })
})

describe("artifactBlobUrl", () => {
  it.each([
    "https://cdn.zk.money/profiles/v5/current.json",
    "https://cdn.zk.money/profiles/v5/0.5.1.json",
  ])("derives the blob beside the profile at %s", (profileUrl) => {
    expect(artifactBlobUrl(profileUrl, ARTIFACT_SHA)).toBe(
      `https://cdn.zk.money/artifacts/v5/${ARTIFACT_SHA}.json`,
    )
  })

  it("rejects a checksum that is not lowercase SHA-256", () => {
    expect(() => artifactBlobUrl("https://cdn.zk.money/profiles/v5/current.json", "BAD")).toThrow()
  })
})

describe("artifact manifest contract", () => {
  it("checks exact bytes and profile/version identity", async () => {
    const body = bytes(manifest())
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(body))
    const result = await fetchArtifactManifest({
      profileUrl: "https://cdn.zk.money/profiles/v5/current.json",
      profileId: PROFILE_ID,
      versionId: VERSION_ID,
      expectedSha256: sha256(body),
      fetchImpl,
    })
    expect(result.classes[CLASS_ID]?.name).toBe("sipaBroadcaster")
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://cdn.zk.money/artifacts/v5/0.5.1.json",
      expect.objectContaining({ redirect: "error" }),
    )
  })

  it("rejects a manifest checksum mismatch", async () => {
    const body = bytes(manifest())
    await expect(
      fetchArtifactManifest({
        profileUrl: "https://cdn.zk.money/profiles/v5/current.json",
        profileId: PROFILE_ID,
        versionId: VERSION_ID,
        expectedSha256: "f".repeat(64),
        fetchImpl: async () => new Response(body),
      }),
    ).rejects.toThrow(/checksum differs/)
  })

  it.each([
    ["profile", manifest({ profileId: "staging-v5" })],
    ["version", manifest({ versionId: "0.5.2" })],
  ])("rejects a %s identity mismatch", async (_label, document) => {
    const body = bytes(document)
    await expect(
      fetchArtifactManifest({
        profileUrl: "https://cdn.zk.money/profiles/v5/current.json",
        profileId: PROFILE_ID,
        versionId: VERSION_ID,
        expectedSha256: sha256(body),
        fetchImpl: async () => new Response(body),
      }),
    ).rejects.toThrow(/identifies as|for version/)
  })

  it("accepts a checksum-only entry", () => {
    const entry = Object.values(manifest().classes)[0]!
    const parsed = parseArtifactManifest(
      manifest({ classes: { [CLASS_ID]: { ...entry, artifact: { sha256: ARTIFACT_SHA } } } }),
    )
    expect(parsed.classes[CLASS_ID]!.artifact).toEqual({ sha256: ARTIFACT_SHA })
  })

  it("rejects malformed and duplicate class ids", () => {
    const malformed = manifest({ classes: { bad: Object.values(manifest().classes)[0] } })
    expect(() => parseArtifactManifest(malformed)).toThrow(/invalid Aztec class id/)

    const upper = `0x${"A".repeat(64)}`
    const lower = upper.toLowerCase()
    const entry = Object.values(manifest().classes)[0]!
    expect(() =>
      parseArtifactManifest(manifest({ classes: { [upper]: entry, [lower]: entry } })),
    ).toThrow(/duplicate Aztec class id/)
  })

  it.each([
    ["bad artifact sha", { sha256: "bad" }],
    [
      "credential URL",
      { url: `https://user:secret@cdn.zk.money/artifacts/v5/${ARTIFACT_SHA}.json` },
    ],
    ["plaintext URL", { url: `http://cdn.zk.money/artifacts/v5/${ARTIFACT_SHA}.json` }],
  ])("rejects %s", (_label, artifactOverride) => {
    const entry = Object.values(manifest().classes)[0]!
    expect(() =>
      parseArtifactManifest(
        manifest({
          classes: {
            [CLASS_ID]: { ...entry, artifact: { ...entry.artifact, ...artifactOverride } },
          },
        }),
      ),
    ).toThrow()
  })
})

describe("createArtifactPinResolver", () => {
  it("fetches one manifest under concurrent class lookups", async () => {
    const body = bytes(manifest())
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(body))
    const resolve = createArtifactPinResolver({
      profileUrl: "https://cdn.zk.money/profiles/v5/current.json",
      profileId: PROFILE_ID,
      versionId: VERSION_ID,
      expectedSha256: sha256(body),
      fetchImpl,
    })
    const [first, second] = await Promise.all([resolve(CLASS_ID), resolve(CLASS_ID)])
    expect(first).toEqual(second)
    expect(first).toEqual({
      url: `https://cdn.zk.money/artifacts/v5/${ARTIFACT_SHA}.json`,
      sha256: ARTIFACT_SHA,
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it("derives the blob URL from the profile URL when the manifest names none", async () => {
    const entry = Object.values(manifest().classes)[0]!
    const body = bytes(
      manifest({ classes: { [CLASS_ID]: { ...entry, artifact: { sha256: ARTIFACT_SHA } } } }),
    )
    const resolve = createArtifactPinResolver({
      profileUrl: "https://cdn.staging.zk.money/profiles/v5/current.json",
      profileId: PROFILE_ID,
      versionId: VERSION_ID,
      expectedSha256: sha256(body),
      fetchImpl: async () => new Response(body),
    })
    expect(await resolve(CLASS_ID)).toEqual({
      url: `https://cdn.staging.zk.money/artifacts/v5/${ARTIFACT_SHA}.json`,
      sha256: ARTIFACT_SHA,
    })
  })

  it("refuses a named URL that is not where the profile's store serves the blob", async () => {
    const body = bytes(manifest())
    const resolve = createArtifactPinResolver({
      profileUrl: "https://cdn.staging.zk.money/profiles/v5/current.json",
      profileId: PROFILE_ID,
      versionId: VERSION_ID,
      expectedSha256: sha256(body),
      fetchImpl: async () => new Response(body),
    })
    await expect(resolve(CLASS_ID)).rejects.toThrow(/names https:\/\/cdn\.zk\.money/)
  })

  it("keeps a legacy profile usable until an unbundled class needs its missing pin", async () => {
    const fetchImpl = vi.fn()
    const resolve = createArtifactPinResolver({
      profileUrl: "https://cdn.zk.money/profiles/v5/0.4.0.json",
      profileId: PROFILE_ID,
      versionId: "0.4.0",
      fetchImpl,
    })
    expect(fetchImpl).not.toHaveBeenCalled()
    await expect(resolve(CLASS_ID)).rejects.toThrow(/has no artifact manifest pin/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

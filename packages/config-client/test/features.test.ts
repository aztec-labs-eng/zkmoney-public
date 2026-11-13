/**
 * The features document and its generic layer, over a mock registry: nothing here depends on any
 * real feature.
 */
import { describe, expect, it } from "vitest"
import { z } from "zod"
import type { OxideDeployment } from "@obsidion/core/oxide"
import {
  FeaturesDocumentError,
  defineFeature,
  featuresUrl,
  fetchFeaturesDocument,
  parseFeaturesDocument,
  parseServedFeatures,
  resolveFeatureRoles,
} from "../src/index.js"

const MOCK_CONTRACT = `0x${"a1".repeat(20)}`
const EXPECTED = { profileId: "mock-v1", network: "testnet" } as const

const mockFeature = defineFeature({
  id: "mockFeature",
  schema: z.strictObject({ label: z.string(), endpoint: z.string() }),
  oxide: {
    mockRole: {
      project: "mock-project",
      contracts: ["mockContract"],
      bridges: ["mockBridgeRole"],
      optional: true,
    },
  },
  check: ({ label }) => (label === "refused" ? [{ message: "mock check", path: ["label"] }] : []),
})
const mockRequired = defineFeature({
  id: "mockRequired",
  schema: z.strictObject({ label: z.string() }),
  oxide: { mockRole: { project: "mock-project" } },
})
const REGISTRY = [mockFeature, mockRequired] as const

type Doc = Record<string, any>

function doc(): Doc {
  return {
    schemaVersion: "1",
    profileId: "mock-v1",
    network: "testnet",
    features: {
      mockFeature: {
        label: "mock",
        endpoint: "https://mock.example",
        oxide: { mockRole: "mock-oxide-feature" },
      },
    },
  }
}

function changed(edit: (d: Doc) => void): Doc {
  const d = doc()
  edit(d)
  return d
}

const parse = (d: Doc) => parseFeaturesDocument(d, REGISTRY)
const served = (d: Doc, now?: () => Date) =>
  parseServedFeatures(d, { expected: EXPECTED, registry: REGISTRY, now })

const oxideFeature = (
  id: string,
  project: string,
  contracts: Record<string, string> = {},
  bridges: Record<string, string> = {},
) => ({ id, project, contracts, bridges, variables: {} })

function deployment(features: OxideDeployment["features"]): OxideDeployment {
  return {
    label: "mock",
    rollupVersion: "1",
    bridges: [
      {
        id: "mock-bridge",
        underlying: "0x01",
        token: "0x01",
        portal: "0x02",
        l2Token: "0x03",
        tuple: {} as OxideDeployment["bridges"][number]["tuple"],
      },
    ],
    features,
  }
}

const usable = oxideFeature(
  "mock-oxide-feature",
  "mock-project",
  { mockContract: MOCK_CONTRACT },
  { mockBridgeRole: "mock-bridge" },
)

async function code(run: () => unknown): Promise<string> {
  try {
    await run()
  } catch (e) {
    if (e instanceof FeaturesDocumentError) return e.code
    throw e
  }
  throw new Error("expected a FeaturesDocumentError")
}

describe("parseFeaturesDocument", () => {
  it("reads each feature's payload and its Oxide bindings", () => {
    const { features } = parse(doc())
    expect(features.mockFeature).toEqual({
      label: "mock",
      endpoint: "https://mock.example",
      oxide: { mockRole: "mock-oxide-feature" },
    })
  })

  it.each<[string, (d: Doc) => void, RegExp]>([
    ["an unknown feature", (d) => (d.features.mockUnknown = {}), /unknown feature "mockUnknown"/],
    ["a stray key", (d) => (d.features.mockFeature.mockStray = 1), /mockStray/],
    ["an undeclared role", (d) => (d.features.mockFeature.oxide.mockOther = "x"), /oxide/],
    ["a required role unbound", (d) => (d.features.mockRequired = { label: "mock" }), /mockRole/],
    ["a feature's own rule", (d) => (d.features.mockFeature.label = "refused"), /mock check/],
    [
      "an http URL off sandbox",
      (d) => (d.features.mockFeature.endpoint = "http://mock.example"),
      /must be https/,
    ],
    [
      "an expiry before publication",
      (d) =>
        Object.assign(d, {
          publishedAt: "2026-11-10T00:00:00Z",
          expiresAt: "2026-11-09T00:00:00Z",
        }),
      /expiresAt/,
    ],
    ["another schema", (d) => (d.schemaVersion = "2"), /schemaVersion/],
  ])("refuses %s", (_, edit, message) => {
    expect(() => parse(changed(edit))).toThrow(message)
  })

  it("allows http on sandbox", () => {
    const d = changed((d) => {
      d.network = "sandbox"
      d.features.mockFeature.endpoint = "http://mock.example"
    })
    expect(parse(d).features.mockFeature?.endpoint).toBe("http://mock.example")
  })
})

describe("parseServedFeatures", () => {
  it("skips unknown features and keys", () => {
    const result = served(
      changed((d) => {
        d.mockAddedLater = true
        d.features.mockUnknown = { label: "mock" }
        d.features.mockFeature.mockAddedLater = 1
      }),
    )
    expect(Object.keys(result.features)).toEqual(["mockFeature"])
    expect(result.features.mockFeature).not.toHaveProperty("mockAddedLater")
    expect(result.rejected).toEqual([])
  })

  it.each<[string, Doc["features"][string], RegExp]>([
    ["fails its schema", { label: 1, oxide: { mockRole: "mock-oxide-feature" } }, /label/],
    ["leaves a required role unbound", { label: "mock" }, /required role "mockRole"/],
  ])("turns off only an entry that %s", (_, entry, reason) => {
    const result = served(changed((d) => (d.features.mockRequired = entry)))
    expect(Object.keys(result.features)).toEqual(["mockFeature"])
    expect(result.rejected.map((r) => r.id)).toEqual(["mockRequired"])
    expect(result.rejected[0]?.reason).toMatch(reason)
  })

  it.each<[string, (d: Doc) => void, string]>([
    ["another schema", (d) => (d.schemaVersion = "2"), "UNSUPPORTED_SCHEMA"],
    ["another profile", (d) => (d.profileId = "mock-other-v1"), "IDENTITY_MISMATCH"],
    ["another network", (d) => (d.network = "mainnet"), "IDENTITY_MISMATCH"],
    ["a passed expiry", (d) => (d.expiresAt = "2026-01-01T00:00:00Z"), "EXPIRED"],
    ["no features map", (d) => delete d.features, "INVALID_DOCUMENT"],
  ])("throws for %s", async (_, edit, expected) => {
    const now = () => new Date("2026-11-10T00:00:00Z")
    expect(await code(() => served(changed(edit), now))).toBe(expected)
  })
})

describe("resolveFeatureRoles", () => {
  const resolve = (d: Doc, features: OxideDeployment["features"]) =>
    resolveFeatureRoles(parse(d).features, deployment(features), REGISTRY)

  it("binds each role to the deployment's Oxide feature", () => {
    const resolved = resolve(doc(), [usable])
    expect(resolved.problems).toEqual([])
    expect(resolved.features.mockFeature?.oxide.mockRole).toEqual(usable)
  })

  it.each<[string, OxideDeployment["features"], string]>([
    ["absent", [], "role.unknownFeature"],
    [
      "from another project",
      [oxideFeature("mock-oxide-feature", "mock-other-project")],
      "role.wrongProject",
    ],
    [
      "without its contract",
      [{ ...usable, contracts: { mockContract: `0x${"0".repeat(40)}` } }],
      "role.missingContract",
    ],
    [
      "binding no deployment bridge",
      [{ ...usable, bridges: { mockBridgeRole: "mock-gone" } }],
      "role.missingBridge",
    ],
  ])("keeps a feature whose optional role is %s, without the role", (_, features, problem) => {
    const resolved = resolve(doc(), features)
    expect(resolved.features.mockFeature?.oxide.mockRole).toBeUndefined()
    expect(resolved.features.mockFeature?.label).toBe("mock")
    expect(resolved.problems).toMatchObject([
      { feature: "mockFeature", code: problem, featureOff: false },
    ])
  })

  it.each<[string, string, boolean]>([
    ["of its project", "mock-project", true],
    ["of another project", "mock-other-project", false],
  ])("turns a required role's feature off unless its Oxide feature is %s", (_, project, on) => {
    const d = changed(
      (d) =>
        (d.features = { mockRequired: { label: "mock", oxide: { mockRole: "mock-required" } } }),
    )
    const resolved = resolve(d, [oxideFeature("mock-required", project)])
    expect(Boolean(resolved.features.mockRequired)).toBe(on)
    expect(resolved.problems.map((p) => p.featureOff)).toEqual(on ? [] : [true])
  })
})

describe("featuresUrl", () => {
  it.each([
    ["https://c.example/profiles/v5/current.json", "https://c.example/features/v5/current.json"],
    ["https://c.example/profiles/v5/0.5.1.json", "https://c.example/features/v5/current.json"],
    [
      "http://localhost:8083/profiles/sandbox-v5.json?x=1",
      "http://localhost:8083/features/sandbox-v5.json",
    ],
  ])("derives %s", (profileUrl, expected) => {
    expect(featuresUrl(profileUrl)).toBe(expected)
  })

  it("refuses a URL no store layout names", () => {
    expect(() => featuresUrl("https://c.example/other.json")).toThrow(/no features document/)
  })
})

describe("fetchFeaturesDocument", () => {
  it.each<[string, () => Response, string]>([
    ["a body that is not JSON", () => new Response("<html>", { status: 200 }), "INVALID_DOCUMENT"],
    ["a 404", () => new Response("", { status: 404 }), "NOT_FOUND"],
    ["a 403", () => new Response("", { status: 403 }), "HTTP_ERROR"],
    ["a 503", () => new Response("", { status: 503 }), "UNREACHABLE"],
  ])("classifies %s", async (_, respond, expected) => {
    const fetchImpl: typeof fetch = async () => respond()
    const options = { expected: EXPECTED, registry: REGISTRY, fetchImpl }
    expect(await code(() => fetchFeaturesDocument("https://c.example/f.json", options))).toBe(
      expected,
    )
  })
})

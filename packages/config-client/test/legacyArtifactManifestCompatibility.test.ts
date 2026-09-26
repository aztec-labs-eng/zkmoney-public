import { describe, expect, it, vi } from "vitest"

/**
 * Freeze the only schema delta an already-deployed pre-manifest client sees. Its wire parser is
 * byte-for-byte unchanged: strict authoring parse first, then prune additive unrecognized keys and
 * reparse. Mocking the old schema here proves the exact field is handled by that legacy wire path,
 * rather than merely testing today's schema (which already knows the field).
 */
vi.mock("../src/schema.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/schema.js")>()
  const { ZodError } = await import("zod")
  return {
    ...actual,
    parseConfigProfile(data: unknown) {
      const versions = (data as { versions?: Record<string, Record<string, unknown>> })?.versions
      const issues = Object.entries(versions ?? {}).flatMap(([versionId, version]) =>
        Object.hasOwn(version, "artifactManifestSha256")
          ? [
              {
                code: "unrecognized_keys" as const,
                keys: ["artifactManifestSha256"],
                path: ["versions", versionId],
                message: 'Unrecognized key: "artifactManifestSha256"',
              },
            ]
          : [],
      )
      if (issues.length > 0) throw new ZodError(issues)
      return actual.parseConfigProfile(data)
    },
  }
})

import { parseServedProfile, resolveVersion } from "../src/client.js"
import { parseConfigProfile } from "../src/schema.js"
import { stagingDoc } from "./fixture.js"

describe("pre-artifact-manifest client compatibility", () => {
  it("prunes the additive schema-1 pin on the wire instead of rejecting the profile", () => {
    const doc = stagingDoc()
    doc.versions[doc.current].artifactManifestSha256 = "a".repeat(64)

    // Authoring was strict before the field existed, but deployed consumers do not call this path.
    expect(() => parseConfigProfile(doc)).toThrow(/artifactManifestSha256/)

    const served = parseServedProfile(doc)
    const version = resolveVersion(served).version
    expect(version.nodeUrl).toBe("https://node.example")
    expect("artifactManifestSha256" in version).toBe(false)
    expect(doc.versions[doc.current].artifactManifestSha256).toBe("a".repeat(64))
  })
})

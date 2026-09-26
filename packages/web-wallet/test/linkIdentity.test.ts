// @vitest-environment node
import { describe, expect, it } from "vitest"
import { paylinkIdentity } from "@obsidion/front-core"
import { decodePaylinkInline } from "@obsidion/sdk"
import { linkIdentity } from "../src/features/paylink/linkIdentity"
import { PAYLINK_FRAGMENT, PREPARED_PAYLINK_FRAGMENTS } from "./fixtures/scanPayloads"

describe("linkIdentity", () => {
  it("is the withdrawal records' identity for the link, and carries none of the fragment", () => {
    const id = linkIdentity(PAYLINK_FRAGMENT)
    expect(id).toBe(paylinkIdentity(decodePaylinkInline(PAYLINK_FRAGMENT)))
    expect(id).toMatch(/^0x[0-9a-f]{64}$/)
    expect(PAYLINK_FRAGMENT).not.toContain(id.slice(2))
    expect(linkIdentity(PREPARED_PAYLINK_FRAGMENTS.direct)).not.toBe(id)
  })

  it("refuses what is not a link", () => {
    expect(() => linkIdentity("not-a-link")).toThrow(/Invalid paylink link/)
  })
})

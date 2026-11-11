import { basename } from "node:path"
import { describe, expect, it } from "vitest"

import { compilablePackages } from "../../scripts/noir-source.mjs"
import { readPins, verify } from "../../scripts/pinned-contracts.mjs"

// The pinned artifacts are what CI, deploys and bootstrap ship. This checks them from the committed
// bytes alone: each package's source still matches its pin, and each contract artifact still
// derives the class id pins.json records.
describe("pinned contracts", () => {
  it("pins every Noir package the wallet builds", () => {
    expect(Object.keys(readPins()).sort()).toEqual(
      compilablePackages()
        .map((p: string) => basename(p))
        .sort(),
    )
  })

  it("matches its sources, bytes and class ids", async () => {
    await expect(verify()).resolves.toBeUndefined()
  }, 120_000)
})

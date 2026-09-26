import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  OxideManifestValidationError,
  assertProdOxideTuple,
  extractPinnedOxideEnvTuple,
} from "@obsidion/core/oxide"

const here = dirname(fileURLToPath(import.meta.url))
const fixture = JSON.parse(readFileSync(resolve(here, "fixtures/manifest.v4.json"), "utf8"))
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v))
const entry = (doc: any) => doc.deployments.find((d: { label: string }) => d.label === "v1")
const PORTAL = entry(fixture).portal
const SHA = entry(fixture).gitSha
const ZERO_L1 = "0x" + "0".repeat(40)
const gate = { requireProdSchema: true, expectedGitSha: SHA }

describe("the mainnet gate on the pinned v4 entry", () => {
  it("accepts the real staging-shaped entry under the gate", () => {
    expect(extractPinnedOxideEnvTuple(fixture, { portal: PORTAL }, gate).tuple.portal).toBe(PORTAL)
  })

  it("does not require accountFactory, entryPoint or ensDomain", () => {
    const lean = clone(fixture)
    const e = entry(lean)
    delete e.accountFactory
    e.entryPoint = ZERO_L1
    delete e.ensDomain
    expect(() => extractPinnedOxideEnvTuple(lean, { portal: PORTAL }, gate)).not.toThrow()
  })

  it("rejects a zero or malformed required handle only under the gate", () => {
    for (const [field, value] of [
      ["nameRegistry", ZERO_L1],
      ["plainWithdrawalExecutor", ZERO_L1],
      ["l2Broadcaster", "0x" + "0".repeat(64)],
      ["resolverGatewayUrl", "not a url"],
      ["swapEscrowFactory", ZERO_L1],
    ] as const) {
      const bad = clone(fixture)
      entry(bad)[field] = value
      expect(() => extractPinnedOxideEnvTuple(bad, { portal: PORTAL }, gate), field).toThrow(
        OxideManifestValidationError,
      )
      expect(() => extractPinnedOxideEnvTuple(bad, { portal: PORTAL }), field).not.toThrow()
    }
  })

  it("rejects an entry that predates withdraw and execute only under the gate", () => {
    const legacy = clone(fixture)
    delete entry(legacy).plainWithdrawalExecutor
    expect(() => extractPinnedOxideEnvTuple(legacy, { portal: PORTAL }, gate)).toThrow(
      /plainWithdrawalExecutor/,
    )
    expect(() => extractPinnedOxideEnvTuple(legacy, { portal: PORTAL })).not.toThrow()
  })

  it("accepts an entry without swapEscrowFactory", () => {
    const noSwap = clone(fixture)
    delete entry(noSwap).swapEscrowFactory
    expect(() => extractPinnedOxideEnvTuple(noSwap, { portal: PORTAL }, gate)).not.toThrow()
  })

  it("rejects a gitSha mismatch", () => {
    expect(() =>
      extractPinnedOxideEnvTuple(
        fixture,
        { portal: PORTAL },
        { ...gate, expectedGitSha: "0".repeat(40) },
      ),
    ).toThrow(/gitSha/)
    const tuple = extractPinnedOxideEnvTuple(fixture, { portal: PORTAL }).tuple
    expect(() => assertProdOxideTuple(tuple, { expectedGitSha: "0".repeat(40) })).toThrow(/gitSha/)
    expect(() => assertProdOxideTuple(tuple, gate)).not.toThrow()
  })
})

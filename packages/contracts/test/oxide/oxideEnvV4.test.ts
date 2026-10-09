import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  OxideManifestValidationError,
  extractPinnedOxideEnvTuple,
  migrationSources,
  parseDeployment,
  pinnedEntryPolicy,
  selectDeployment,
} from "@obsidion/core/oxide"
import { Network } from "@obsidion/core/constants"

const here = dirname(fileURLToPath(import.meta.url))
const fixture = JSON.parse(readFileSync(resolve(here, "fixtures/manifest.v4.json"), "utf8"))
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v))
const entry = (label: string) =>
  fixture.deployments.find((d: { label: string }) => d.label === label)
const V1 = entry("v1")
const V2 = entry("v2")

describe("selectDeployment", () => {
  it("finds the entry by lowercase portal", () => {
    expect(selectDeployment(fixture, { portal: V1.portal.toLowerCase() }).label).toBe("v1")
    expect(
      selectDeployment(fixture, { portal: V2.portal.toUpperCase().replace("0X", "0x") }).label,
    ).toBe("v2")
  })

  it("names the pinned portal and every available portal when absent", () => {
    const pin = "0x0000000000000000000000000000000000000001"
    expect(() => selectDeployment(fixture, { portal: pin })).toThrow(OxideManifestValidationError)
    expect(() => selectDeployment(fixture, { portal: pin })).toThrow(
      new RegExp(`${pin}.*${V1.portal}.*${V2.portal}`, "i"),
    )
  })

  it("refuses a v3 document and a malformed envelope", () => {
    const v3 = { schemaVersion: "3", shared: {}, versions: {} }
    expect(() => selectDeployment(v3, { portal: V1.portal })).toThrow(/schemaVersion/)
    expect(() => selectDeployment({ schemaVersion: "4" }, { portal: V1.portal })).toThrow(
      /deployments/,
    )
    expect(() =>
      selectDeployment({ schemaVersion: "4", deployments: [null] }, { portal: V1.portal }),
    ).toThrow(/deployments\[0\]/)
  })
})

describe("parseDeployment", () => {
  it("maps an entry onto the tuple field for field", () => {
    const { tuple, timestampMs } = parseDeployment(V1)
    expect(timestampMs).toBe(Date.parse(V1.updatedAt))
    expect(Object.isFrozen(tuple)).toBe(true)
    expect(tuple).toEqual({
      version: "v1",
      gitSha: V1.gitSha,
      timestamp: V1.updatedAt,
      deployedAt: V1.deployedAt,
      portal: V1.portal,
      token: V1.token,
      l2Token: V1.l2Token,
      enclaveUrl: V1.enclaveUrl,
      pcr0: V1.pcr0,
      rollupVersion: V1.rollupVersion,
      chainId: V1.chainId,
      certManager: V1.certManager,
      nitroValidator: V1.nitroValidator,
      registry: V1.nameRegistry,
      accountMetadataRegistry: V1.accountMetadataRegistry,
      accountFactory: V1.accountFactory,
      registrationController: V1.registrationController,
      namePortal: V1.namePortal,
      paymaster: V1.paymaster,
      entryPoint: V1.entryPoint,
      ensDomain: V1.ensDomain,
      sipaFactory: V1.sipaFactory,
      sipaRecoveryProtocol: "legacy-eoa",
      sipaResolver: V1.sipaResolver,
      resolverProofVerifier: V1.resolverProofVerifier,
      resolverGatewayUrl: V1.resolverGatewayUrl,
      depositSIPAImplementation: V1.depositSIPAImplementation,
      registrationSIPAImplementation: V1.registrationSIPAImplementation,
      depositSubsidy: V1.depositSubsidy,
      withdrawalSubsidy: V1.withdrawalSubsidy,
      proverSubsidy: V1.proverSubsidy,
      plainWithdrawalExecutor: V1.plainWithdrawalExecutor,
      l2Broadcaster: V1.l2Broadcaster,
      frozenNotesRefundVerifier: V1.frozenNotesRefundVerifier,
      frozenDepositRefundVerifier: V1.frozenDepositRefundVerifier,
      unprocessedDepositRefundVerifier: V1.unprocessedDepositRefundVerifier,
      frozenNotesRefundVkSha256: V1.frozenNotesRefundVkSha256,
      frozenDepositRefundVkSha256: V1.frozenDepositRefundVkSha256,
      swapEscrowFactoryV2: V1.swapEscrowFactoryV2,
      operationExecutor: V1.operationExecutor,
      fpcFunder: V1.fpcFunder,
      fpcBeneficiary: V1.fpcBeneficiary,
      fpcBeneficiarySalt: V1.fpcBeneficiarySalt,
    })
  })

  it("requires portal, token, l2Token, enclaveUrl, label, updatedAt, rollupVersion, chainId", () => {
    const drop = (key: string) => {
      const broken = clone(V1)
      delete broken[key]
      return () => parseDeployment(broken)
    }
    for (const key of [
      "portal",
      "token",
      "l2Token",
      "enclaveUrl",
      "label",
      "updatedAt",
      "rollupVersion",
      "chainId",
    ]) {
      expect(drop(key), key).toThrow(new RegExp(key))
    }
    expect(() => parseDeployment({ ...clone(V1), rollupVersion: "abc" })).toThrow(/rollupVersion/)
    expect(() => parseDeployment({ ...clone(V1), chainId: "0" })).toThrow(/chainId/)
    expect(() => parseDeployment({ ...clone(V1), updatedAt: "yesterday" })).toThrow(/updatedAt/)
  })

  it("rejects a deployedAt that is shaped like a date but is not one", () => {
    expect(() => parseDeployment({ ...clone(V1), deployedAt: "2026-12-01" })).toThrow(/deployedAt/)
    expect(() => parseDeployment({ ...clone(V1), deployedAt: "2026-12-34T00:00:00Z" })).toThrow(
      /deployedAt is not parseable/,
    )
  })

  it("carries deployedAtBlock as a decimal string, whether the entry wrote one or a number", () => {
    for (const written of ["1234", 1234]) {
      expect(
        parseDeployment({ ...clone(V1), deployedAtBlock: written }).tuple.deployedAtBlock,
      ).toBe("1234")
    }
  })

  it("reads an absent or malformed deployedAtBlock as absent, leaving the header search to bound the scan", () => {
    for (const written of [undefined, "", "0x4d2", "12.5", -1, "twelve"]) {
      const entry = { ...clone(V1), deployedAtBlock: written }
      expect(parseDeployment(entry).tuple.deployedAtBlock, String(written)).toBeUndefined()
    }
  })
})

describe("migrationSources", () => {
  it("returns every other entry on the pinned rollup", () => {
    const pinned = parseDeployment(V2).tuple
    expect(migrationSources(fixture, pinned).map((t) => t.version)).toEqual(["v1"])
  })

  it("never returns the pinned portal, compared lowercase", () => {
    const pinned = {
      ...parseDeployment(V1).tuple,
      portal: V1.portal.toUpperCase().replace("0X", "0x"),
    }
    expect(migrationSources(fixture, pinned).map((t) => t.portal)).toEqual([V2.portal])
  })

  it("skips entries that predate withdraw and execute", () => {
    const pinned = parseDeployment(V2).tuple
    const legacy = entry("v0")
    expect(legacy.rollupVersion).toBe(V2.rollupVersion)
    expect(migrationSources(fixture, pinned).map((t) => t.version)).not.toContain("v0")
  })

  it("throws on a malformed known-schema entry instead of dropping it", () => {
    const broken = clone(fixture)
    broken.deployments.find((d: { label: string }) => d.label === "v1").rollupVersion =
      "not-a-number"
    expect(() => migrationSources(broken, parseDeployment(V2).tuple)).toThrow(/rollupVersion/)
  })
})

describe("extractPinnedOxideEnvTuple", () => {
  it("reads the entry the profile's portal pins", () => {
    const profile = { manifestUrl: "https://m.example/staging.v4.json", portal: V1.portal }
    expect(extractPinnedOxideEnvTuple(fixture, profile).tuple.version).toBe("v1")
  })

  it("applies the mainnet parity gate to the pinned entry", () => {
    const profile = { manifestUrl: "https://m.example/prod.v4.json", portal: V1.portal }
    expect(() =>
      extractPinnedOxideEnvTuple(fixture, profile, {
        requireProdSchema: true,
        expectedGitSha: "0".repeat(40),
      }),
    ).toThrow(/gitSha/)
  })
})

describe("duplicate deployments", () => {
  it("refuses two entries with one portal, compared lowercase, through the pinned read", () => {
    const twice = clone(fixture)
    twice.deployments.push({ ...clone(V1), portal: V1.portal.toUpperCase().replace("0X", "0x") })
    const profile = { manifestUrl: "https://m.example/staging.v4.json", portal: V2.portal }
    expect(() => extractPinnedOxideEnvTuple(twice, profile)).toThrow(/share portal/)
  })

  it("refuses two entries with one label through migrationSources", () => {
    const twice = clone(fixture)
    twice.deployments.push({ ...clone(V2), portal: "0x" + "7".repeat(40), label: V1.label })
    expect(() => migrationSources(twice, parseDeployment(V2).tuple)).toThrow(/share label v1/)
  })
})

describe("pinnedEntryPolicy", () => {
  it("gates the pinned entry on mainnet only", () => {
    expect(pinnedEntryPolicy({ network: Network.MAINNET, expectedGitSha: "a".repeat(40) })).toEqual(
      {
        requireProdSchema: true,
        expectedGitSha: "a".repeat(40),
      },
    )
    expect(
      pinnedEntryPolicy({ network: Network.TESTNET, expectedGitSha: "a".repeat(40) }),
    ).toBeUndefined()
    expect(pinnedEntryPolicy({ network: Network.SANDBOX })).toBeUndefined()
  })
})

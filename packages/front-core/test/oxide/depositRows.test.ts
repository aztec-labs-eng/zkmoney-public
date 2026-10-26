import { describe, expect, it } from "vitest"
import { MAINNET_DAI, MAINNET_USDC, MAINNET_USDT } from "@oxide/l1-contracts"
import { pinnedOxideDeployment, type OxideDeploymentTable } from "@obsidion/core/oxide"
import { depositRows, mainDepositTokenRoutes } from "../../src/oxide/depositTokenRoutes"

const DAI = "0x00000000000000000000000000000000000000d1"
const SUSDS = "0x00000000000000000000000000000000000000d2"
const USD2 = "0x00000000000000000000000000000000000000d3"
const MAIN_PORTAL = "0x00000000000000000000000000000000000000aa"
const l1 = (byte: string) => `0x${byte.repeat(20)}`
const l2 = (byte: string) => `0x${byte.repeat(32)}`
const terms = { sweepTip: 1n, beneficiaryFee: 0n }

const bridge = (key: string, token: string, portal: string, byte: string) => ({
  key,
  bridgeId: `brg-${key}-sandbox`,
  token,
  underlying: token,
  portal,
  l2Token: l2(byte),
  plainWithdrawalExecutor: l1(`e${byte[1]}`),
  withdrawalSubsidy: l1(`c${byte[1]}`),
})

const SKY_FEATURE = {
  "fea-sky-sandbox": {
    project: "sky",
    bridges: { sUsds: "brg-susds-sandbox", dai: "brg-dai-sandbox" },
    contracts: { skyWithdrawalExecutor: l1("e5"), skyEscrowFactory: l1("fa") },
  },
}

/** One deployment of `bridges`, whose fee token is `feeToken`, every row pricing a deposit and a registration. */
function table(
  bridges: ReturnType<typeof bridge>[],
  extra: Record<string, unknown> = {},
  feeToken = DAI,
): OxideDeploymentTable {
  const manifest = {
    schemaVersion: "5",
    deployments: [
      {
        label: "sandbox",
        deployedAt: "2026-10-20T00:00:00.000Z",
        updatedAt: "2026-10-20T00:00:00.000Z",
        chainId: "31337",
        rollupVersion: "1",
        enclaveUrl: "http://localhost:5071/rpc",
        forwardingTable: l1("fb"),
        feeToken,
        ...extra,
        bridges,
      },
    ],
  }
  const { deployment } = pinnedOxideDeployment(manifest, { portal: bridges[0]!.portal })
  return {
    deployment,
    rows: deployment.bridges.map((bridge) => ({
      bridge,
      intents: { deposit: terms, registration: terms },
      txAmountCap: 100n,
    })),
  }
}

/** The sandbox's two rows: sUSDS, then DAI, the fee token. */
const SKY_ROWS = [bridge("susds", SUSDS, l1("bb"), "a2"), bridge("dai", DAI, MAIN_PORTAL, "a1")]

const underlying = (rows: { bridge: { underlying: string } }[]) =>
  rows.map((row) => row.bridge.underlying.toLowerCase())

describe("depositRows", () => {
  it("offers DAI on Main and keeps sUSDS, which the Sky feature binds, as the feature's product row", () => {
    const rows = depositRows(table(SKY_ROWS, { features: SKY_FEATURE }))

    expect(underlying(rows.main)).toEqual([DAI])
    expect(underlying(rows.product.map(({ row }) => row))).toEqual([SUSDS])
    expect(rows.product[0]).toMatchObject({ feature: { id: "fea-sky-sandbox" }, role: "sUsds" })
  })

  it("offers both rows of a table no feature binds", () => {
    const rows = depositRows(table(SKY_ROWS))

    expect(underlying(rows.main)).toEqual([SUSDS, DAI])
    expect(rows.product).toEqual([])
  })

  it("offers a plain row beside a feature's, with no change to the policy", () => {
    const rows = depositRows(
      table([...SKY_ROWS, bridge("usd2", USD2, l1("cc"), "a3")], { features: SKY_FEATURE }),
    )

    expect(underlying(rows.main)).toEqual([DAI, USD2])
    expect(underlying(rows.product.map(({ row }) => row))).toEqual([SUSDS])
  })

  it("keeps Sky's DAI on Main when another token pays the fees", () => {
    const rows = depositRows(
      table([...SKY_ROWS, bridge("usd2", USD2, l1("cc"), "a3")], { features: SKY_FEATURE }, USD2),
    )

    expect(underlying(rows.main)).toEqual([DAI, USD2])
    expect(underlying(rows.product.map(({ row }) => row))).toEqual([SUSDS])
  })

  it("keeps the fee token's row on Main whatever role a feature binds it in", () => {
    const features = {
      "fea-other-sandbox": {
        project: "other",
        bridges: { asset: "brg-dai-sandbox" },
        contracts: {},
      },
    }

    expect(underlying(depositRows(table(SKY_ROWS, { features })).main)).toEqual([SUSDS, DAI])
  })
})

describe("mainDepositTokenRoutes", () => {
  it("lists only DAI of the Sky table for a deposit and a registration", () => {
    const sky = table(SKY_ROWS, { features: SKY_FEATURE })

    for (const intent of ["deposit", "registration"] as const) {
      expect(mainDepositTokenRoutes(sky, 31337, intent).map((r) => r.token.toLowerCase())).toEqual([
        DAI,
      ])
    }
  })

  it("lists the mainnet swap inputs of Main's DAI row and no product row", () => {
    const dai = MAINNET_DAI.toString()
    const sky = table(
      [bridge("susds", SUSDS, l1("bb"), "a2"), bridge("dai", dai, MAIN_PORTAL, "a1")],
      { features: SKY_FEATURE },
      dai,
    )

    expect(mainDepositTokenRoutes(sky, 1).map((r) => [r.token, r.swapped])).toEqual([
      [dai, false],
      [MAINNET_USDC.toString(), true],
      [MAINNET_USDT.toString(), true],
    ])
  })
})

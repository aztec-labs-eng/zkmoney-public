import assert from "node:assert/strict"
import { test } from "node:test"
import {
  deploymentHoldings,
  holdingCatalog,
  pinnedOxideDeployment,
} from "../../dist/oxide/index.js"

const DAI = "0x6B175474E89094C44Da98b954EedeAC495271d0F"
const SUSDS = "0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD"
const DAI_PORTAL = "0x1E6142c98D83c8D14b09668d90583E940A646458"
const SUSDS_PORTAL = "0x2E6142c98D83c8D14b09668d90583E940A646458"
const FACTORY = "0x00000000000000000000000000000000000000fa"
const SKY_EXECUTOR = "0x00000000000000000000000000000000000000e5"
const ZERO = `0x${"0".repeat(40)}`
const l2 = (byte) => `0x${byte.repeat(32)}`

const bridge = (key, token, portal, byte) => ({
  key,
  bridgeId: `brg-${key}-v6`,
  token,
  underlying: token,
  portal,
  l2Token: l2(byte),
})

const skyFeature = (overrides = {}) => ({
  project: "sky",
  bridges: { dai: "brg-dai-v6", sUsds: "brg-susds-v6" },
  contracts: { skyEscrowFactory: FACTORY, skyWithdrawalExecutor: SKY_EXECUTOR },
  ...overrides,
})

const deployment = (features) =>
  pinnedOxideDeployment(
    {
      schemaVersion: "5",
      deployments: [
        {
          label: "v6.0.0",
          gitSha: "c92f24e54e11222d5255e653d673851122cbbf04",
          deployedAt: "2026-10-13T20:24:20.754Z",
          updatedAt: "2026-10-14T20:24:20.754Z",
          chainId: "1",
          rollupVersion: "2934756905",
          enclaveUrl: "https://enclave.example/rpc",
          feeToken: DAI,
          bridges: [
            bridge("dai", DAI, DAI_PORTAL, "a1"),
            bridge("susds", SUSDS, SUSDS_PORTAL, "b2"),
          ],
          features: {
            "fea-swap-v6": {
              project: "swap",
              bridges: { usdc: "brg-dai-v6" },
              contracts: { swapEscrowFactory: FACTORY },
            },
            ...features,
          },
        },
      ],
    },
    { portal: DAI_PORTAL },
  ).deployment

const skyHolding = () => deploymentHoldings(deployment({ "fea-sky-v6": skyFeature() })).holdings[0]

test("the Sky feature is a yield holding on the escrow rail, its bridges bound by role", () => {
  const d = deployment({ "fea-sky-v6": skyFeature() })
  const [dai, susds] = d.bridges

  assert.deepEqual(deploymentHoldings(d), {
    holdings: [
      {
        id: "fea-sky-v6",
        kind: "yield",
        l2Token: l2("b2"),
        base: dai,
        held: susds,
        terms: "erc4626",
        conversion: "DaiUsds",
        rail: "skyEscrow",
        escrow: { factory: FACTORY, withdrawalExecutor: SKY_EXECUTOR },
      },
    ],
    rejected: [],
  })
})

test("a deployment without a Sky feature has no holdings", () => {
  assert.deepEqual(deploymentHoldings(deployment({})), { holdings: [], rejected: [] })
  const older = { ...deployment({}), features: undefined }
  assert.deepEqual(deploymentHoldings(older), { holdings: [], rejected: [] })
})

test("a Sky feature it cannot use is rejected with its reason", () => {
  const cases = [
    [skyFeature({ bridges: { sUsds: "brg-susds-v6" } }), "holding.missingRole", "dai"],
    [
      skyFeature({ bridges: { dai: "brg-dai-v6", sUsds: "brg-susds-v5" } }),
      "holding.unknownBridge",
      "sUsds brg-susds-v5",
    ],
    ...["skyEscrowFactory", "skyWithdrawalExecutor"].flatMap((field) =>
      [undefined, ZERO, "0x123", `0x${"Z".repeat(40)}`].map((address) => {
        const contracts = { skyEscrowFactory: FACTORY, skyWithdrawalExecutor: SKY_EXECUTOR }
        if (address === undefined) delete contracts[field]
        else contracts[field] = address
        return [skyFeature({ contracts }), "holding.unusableAddress", field]
      }),
    ),
  ]
  for (const [feature, code, detail] of cases) {
    assert.deepEqual(deploymentHoldings(deployment({ "fea-sky-v6": feature })), {
      holdings: [],
      rejected: [{ id: "fea-sky-v6", code, detail }],
    })
  }
})

test("every usable Sky feature is a holding under its own id, beside the ones it rejects", () => {
  const factoryV7 = "0x00000000000000000000000000000000000000fb"
  const d = deployment({
    "fea-sky-v5": skyFeature({ bridges: { sUsds: "brg-susds-v6" } }),
    "fea-sky-v6": skyFeature(),
    "fea-sky-usds-v7": skyFeature({
      contracts: { skyEscrowFactory: factoryV7, skyWithdrawalExecutor: SKY_EXECUTOR },
    }),
    "savings": skyFeature(),
  })
  const { holdings, rejected } = deploymentHoldings(d)

  assert.deepEqual(rejected, [{ id: "fea-sky-v5", code: "holding.missingRole", detail: "dai" }])
  assert.deepEqual(
    holdings.map((h) => [h.id, h.l2Token, h.escrow.factory]),
    [
      ["fea-sky-v6", l2("b2"), FACTORY],
      ["fea-sky-usds-v7", l2("b2"), factoryV7],
      ["savings", l2("b2"), FACTORY],
    ],
  )
})

test("the catalog holds the listed holdings in profile order, the first listed per token in any hex case", () => {
  const sky = skyHolding()
  const other = { ...sky, id: "fea-sky-v5", l2Token: l2("c3") }
  const upper = { ...sky, id: "fea-sky-v7", l2Token: `0x${"B2".repeat(32)}` }
  const all = [sky, other, upper]

  assert.deepEqual(holdingCatalog(all, ["fea-sky-v5", "fea-gone-v6", "fea-sky-v7", "fea-sky-v6"]), {
    holdings: [other, upper],
  })
  assert.deepEqual(holdingCatalog(all, []), { holdings: [] })
})

test("an executor holding takes its token's line from an escrow one, in either order", () => {
  const sky = skyHolding()
  const { escrow: _escrow, ...common } = sky
  const executor = { ...common, id: "fea-vault-sky-v6", rail: "executor" }
  const all = [sky, executor]

  assert.deepEqual(holdingCatalog(all, ["fea-sky-v6", "fea-vault-sky-v6"]), {
    holdings: [executor],
  })
  assert.deepEqual(holdingCatalog(all, ["fea-vault-sky-v6", "fea-sky-v6"]), {
    holdings: [executor],
  })
})

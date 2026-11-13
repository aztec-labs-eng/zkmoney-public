import assert from "node:assert/strict"
import { test } from "node:test"
import {
  deploymentHoldings,
  holdingCatalog,
  pinnedHoldings,
  pinnedOxideDeployment,
} from "../../dist/oxide/index.js"

const DAI = "0x6B175474E89094C44Da98b954EedeAC495271d0F"
const SUSDS = "0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD"
const DAI_PORTAL = "0x1E6142c98D83c8D14b09668d90583E940A646458"
const SUSDS_PORTAL = "0x2E6142c98D83c8D14b09668d90583E940A646458"
const SHARE = "0xbeef088055857739C12CD3765F20b7679Def0f51"
const SHARE_PORTAL = "0x3E6142c98D83c8D14b09668d90583E940A646458"
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

const EXECUTOR = "0x00000000000000000000000000000000000000e7"
const ADAPTERS = {
  erc4626: "0x0000000000000000000000000000000000000ad1",
  portalDeposit: "0x0000000000000000000000000000000000000ad2",
  skyConverter: "0x0000000000000000000000000000000000000ad3",
  makerPsm: "0x0000000000000000000000000000000000000ad4",
  uniswapV3: "0x0000000000000000000000000000000000000ad5",
}

const executorFeature = (contracts = {}) => ({
  project: "multistep",
  bridges: {},
  contracts: {
    multiStepExecutor: EXECUTOR,
    ...Object.fromEntries(Object.entries(ADAPTERS).map(([kind, at]) => [`${kind}Adapter`, at])),
    ...contracts,
  },
})

const vaultFeature = (
  conversion = "Psm",
  bridges = { main: "brg-dai-v6", position: "brg-steakusdc-v6" },
) => ({ project: "position", bridges, contracts: {}, variables: { conversion } })

const pinnedTo = (features, portal = DAI_PORTAL) =>
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
            bridge("steakusdc", SHARE, SHARE_PORTAL, "c3"),
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
    { portal },
  )

const deployment = (features) => pinnedTo(features).deployment

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
  const all = { holdings: [sky, other, upper], rejected: [] }

  assert.deepEqual(holdingCatalog(all, ["fea-sky-v5", "fea-gone-v6", "fea-sky-v7", "fea-sky-v6"]), {
    holdings: [other, upper],
  })
  assert.deepEqual(holdingCatalog(all, []), { holdings: [] })
})

test("an executor holding takes its token's line from an escrow one, in either order", () => {
  const features = {
    "fea-sky-v6": skyFeature(),
    "fea-multistep-v6": executorFeature(),
    "fea-vault-susds-v6": vaultFeature("DaiUsds", { main: "brg-dai-v6", position: "brg-susds-v6" }),
  }
  const all = deploymentHoldings(deployment(features))
  const [sky, executor] = all.holdings

  assert.equal(executor.rail, "executor")
  assert.equal(executor.l2Token, sky.l2Token)
  assert.deepEqual(holdingCatalog(all, ["fea-sky-v6", "fea-vault-susds-v6"]), {
    holdings: [executor],
  })
  assert.deepEqual(holdingCatalog(all, ["fea-vault-susds-v6", "fea-sky-v6"]), {
    holdings: [executor],
  })
})

/** The ids a wallet lists on `features`, pinned to `portal`, under the profile's `list`. */
const listedOn = (features, list, portal) =>
  holdingCatalog(pinnedHoldings(pinnedTo(features, portal)), list).holdings.map((h) => h.id)

test("a profile that names no holdings lists the first Sky feature's holding on the pinned bridge", () => {
  const sky = { "fea-sky-v6": skyFeature() }
  const d = pinnedTo(sky)

  assert.deepEqual(pinnedHoldings(d).holdings, deploymentHoldings(d.deployment).holdings)
  assert.deepEqual(listedOn(sky, undefined), ["fea-sky-v6"])
  // A later Sky feature, here on the same token, is not listed beside the first.
  assert.deepEqual(listedOn({ ...sky, "fea-sky-usds-v7": skyFeature() }, undefined), ["fea-sky-v6"])
  // Its base is the DAI bridge: a wallet pinned to another bridge has no Savings to move to.
  assert.deepEqual(listedOn(sky, undefined, SUSDS_PORTAL), [])
  assert.deepEqual(listedOn({}, undefined), [])
})

test("an unusable first Sky feature lists none, not the next one", () => {
  const features = {
    "fea-sky-v5": skyFeature({ bridges: { sUsds: "brg-susds-v6" } }),
    "fea-sky-v6": skyFeature(),
  }
  const holdings = pinnedHoldings(pinnedTo(features))

  assert.deepEqual(holdings.rejected, deploymentHoldings(deployment(features)).rejected)
  assert.deepEqual(listedOn(features, undefined), [])
  assert.deepEqual(listedOn(features, ["fea-sky-v6"]), ["fea-sky-v6"])
})

test("a vault feature is never listed unless the profile names it", () => {
  const vault = { "fea-multistep-v6": executorFeature(), "fea-vault-steakusdc-v6": vaultFeature() }
  assert.deepEqual(listedOn(vault, undefined), [])
  assert.deepEqual(listedOn({ ...vault, "fea-sky-v6": skyFeature() }, undefined), ["fea-sky-v6"])
  assert.deepEqual(listedOn(vault, ["fea-vault-steakusdc-v6"]), ["fea-vault-steakusdc-v6"])
})

test("the profile's list is authoritative, an empty one too", () => {
  const features = { "fea-sky-v6": skyFeature(), "fea-sky-usds-v7": skyFeature() }

  assert.deepEqual(listedOn(features, []), [])
  assert.deepEqual(listedOn(features, ["fea-sky-usds-v7"]), ["fea-sky-usds-v7"])
  assert.deepEqual(listedOn(features, ["fea-gone-v6"]), [])
})

test("a vault feature is a holding on the executor rail, with the deployment's executor and adapters", () => {
  const d = deployment({
    "fea-multistep-v6": executorFeature({ lifiIntentAdapter: ZERO }),
    "fea-vault-steakusdc-v6": vaultFeature(),
  })
  const [dai, , share] = d.bridges

  assert.deepEqual(deploymentHoldings(d), {
    holdings: [
      {
        id: "fea-vault-steakusdc-v6",
        kind: "yield",
        l2Token: l2("c3"),
        base: dai,
        held: share,
        terms: "erc4626",
        conversion: "Psm",
        rail: "executor",
        executor: { id: "fea-multistep-v6", address: EXECUTOR, adapters: ADAPTERS },
      },
    ],
    rejected: [],
  })
})

test("a vault feature it cannot use is rejected with its reason", () => {
  const executor = { "fea-multistep-v6": executorFeature() }
  const without = (adapter) => ({
    "fea-multistep-v6": executorFeature({ [`${adapter}Adapter`]: ZERO }),
  })
  const cases = [
    [
      executor,
      vaultFeature("Psm", { position: "brg-steakusdc-v6" }),
      "holding.missingRole",
      "main",
    ],
    [
      executor,
      vaultFeature("Psm", { main: "brg-dai-v6", position: "brg-gone-v6" }),
      "holding.unknownBridge",
      "position brg-gone-v6",
    ],
    [executor, vaultFeature("Curve"), "holding.unsupported", "conversion Curve"],
    [{}, vaultFeature(), "holding.noExecutor", "multistep"],
    ...["erc4626", "portalDeposit", "makerPsm", "uniswapV3"].map((adapter) => [
      without(adapter),
      vaultFeature(),
      "holding.unusableAddress",
      `fea-multistep-v6 ${adapter}Adapter`,
    ]),
    [
      without("skyConverter"),
      vaultFeature("DaiUsds"),
      "holding.unusableAddress",
      "fea-multistep-v6 skyConverterAdapter",
    ],
  ]
  for (const [features, feature, code, detail] of cases) {
    assert.deepEqual(
      deploymentHoldings(deployment({ ...features, "fea-vault-steakusdc-v6": feature })),
      { holdings: [], rejected: [{ id: "fea-vault-steakusdc-v6", code, detail }] },
    )
  }
  // A vault with no conversion to step through needs only the terms' and the deposit's adapters.
  const plain = deploymentHoldings(
    deployment({ ...without("makerPsm"), "fea-vault-steakusdc-v6": vaultFeature("None") }),
  )
  assert.deepEqual(plain.rejected, [])
})

test("a vault feature under another id names no kind the wallet reads", () => {
  const read = deploymentHoldings(
    deployment({ "fea-multistep-v6": executorFeature(), "fea-token-eth-v6": vaultFeature() }),
  )
  assert.deepEqual(read, {
    holdings: [],
    rejected: [{ id: "fea-token-eth-v6", code: "holding.unsupported", detail: "fea-token-eth-v6" }],
  })
})

test("an executor feature it cannot use is rejected, and so is each vault that needs it", () => {
  const broken = deploymentHoldings(
    deployment({
      "fea-multistep-v6": executorFeature({ multiStepExecutor: ZERO }),
      "fea-vault-steakusdc-v6": vaultFeature(),
    }),
  )
  assert.deepEqual(broken, {
    holdings: [],
    rejected: [
      { id: "fea-multistep-v6", code: "holding.unusableAddress", detail: "multiStepExecutor" },
      { id: "fea-vault-steakusdc-v6", code: "holding.noExecutor", detail: "fea-multistep-v6" },
    ],
  })

  const two = deploymentHoldings(
    deployment({
      "fea-multistep-v6": executorFeature(),
      "fea-multistep-v6b": executorFeature(),
      "fea-vault-steakusdc-v6": vaultFeature(),
    }),
  )
  const ids = "fea-multistep-v6, fea-multistep-v6b"
  assert.deepEqual(two, {
    holdings: [],
    rejected: [
      { id: "fea-multistep-v6", code: "holding.duplicateExecutor", detail: ids },
      { id: "fea-multistep-v6b", code: "holding.duplicateExecutor", detail: ids },
      { id: "fea-vault-steakusdc-v6", code: "holding.noExecutor", detail: ids },
    ],
  })
})

test("one bad feature never hides another", () => {
  const { holdings, rejected } = deploymentHoldings(
    deployment({
      "fea-sky-v6": skyFeature(),
      "fea-multistep-v6": executorFeature({ skyConverterAdapter: ZERO }),
      "fea-vault-susds-v6": vaultFeature("DaiUsds", {
        main: "brg-dai-v6",
        position: "brg-susds-v6",
      }),
      "fea-vault-steakusdc-v6": vaultFeature(),
    }),
  )
  assert.deepEqual(
    holdings.map((h) => [h.id, h.rail]),
    [
      ["fea-sky-v6", "skyEscrow"],
      ["fea-vault-steakusdc-v6", "executor"],
    ],
  )
  assert.deepEqual(rejected, [
    {
      id: "fea-vault-susds-v6",
      code: "holding.unusableAddress",
      detail: "fea-multistep-v6 skyConverterAdapter",
    },
  ])
})

test("an executor feature without a vault is read as no holding", () => {
  const d = deployment({
    "fea-sky-v6": skyFeature(),
    "fea-multistep-v6": executorFeature({ multiStepExecutor: ZERO }),
  })
  assert.deepEqual(deploymentHoldings(d).rejected, [])
})

test("a vault whose base is another holding's held token keeps its own line", () => {
  const all = deploymentHoldings(
    deployment({
      "fea-sky-v6": skyFeature(),
      "fea-multistep-v6": executorFeature(),
      "fea-vault-steakusdc-v6": vaultFeature("None", {
        main: "brg-susds-v6",
        position: "brg-steakusdc-v6",
      }),
    }),
  )
  const [sky, vault] = all.holdings

  assert.equal(vault.base, sky.held)
  assert.deepEqual(
    holdingCatalog(all, ["fea-sky-v6", "fea-vault-steakusdc-v6"]).holdings.map((h) => h.id),
    ["fea-sky-v6", "fea-vault-steakusdc-v6"],
  )
})

const STEAK = { id: "steakusdc", portal: SHARE_PORTAL, base: DAI_PORTAL, conversion: "Psm" }
const SKY = { id: "fea-sky-v6", portal: SUSDS_PORTAL, base: DAI_PORTAL, conversion: "DaiUsds" }

test("a savings portal the profile names is the holding a manifest vault feature would be, under its id", () => {
  const executor = { "fea-multistep-v6": executorFeature() }
  const listed = deploymentHoldings(
    deployment({ ...executor, "fea-vault-steakusdc-v6": vaultFeature() }),
  )
  const named = deploymentHoldings(deployment(executor), [
    { ...STEAK, portal: SHARE_PORTAL.toLowerCase() },
  ])

  const flat = ({ holdings }) => holdings.map((h) => ({ ...h, base: h.base.id, held: h.held.id }))
  assert.deepEqual(named.rejected, [])
  assert.deepEqual(flat(named), [{ ...flat(listed)[0], id: "steakusdc" }])
})

test("a savings portal is checked like a vault feature", () => {
  const bare = deployment({})
  assert.deepEqual(deploymentHoldings(bare, [STEAK]), {
    holdings: [],
    rejected: [{ id: "steakusdc", code: "holding.noExecutor", detail: "multistep" }],
  })
  assert.deepEqual(
    deploymentHoldings(deployment({ "fea-multistep-v6": executorFeature() }), [
      { ...STEAK, conversion: "Curve" },
    ]).rejected,
    [{ id: "steakusdc", code: "holding.unsupported", detail: "conversion Curve" }],
  )
})

test("a savings portal the deployment lacks adds no holding", () => {
  const gone = { ...STEAK, portal: "0x4E6142c98D83c8D14b09668d90583E940A646458" }
  assert.deepEqual(deploymentHoldings(deployment({}), [gone]), { holdings: [], rejected: [] })
})

test("a savings portal that names a manifest feature keeps that holding, and is rejected when their portals differ", () => {
  const sky = deployment({ "fea-sky-v6": skyFeature() })
  assert.deepEqual(deploymentHoldings(sky, [SKY]), deploymentHoldings(sky))

  const off = deploymentHoldings(sky, [{ ...SKY, base: SHARE_PORTAL }])
  assert.deepEqual(off.holdings, deploymentHoldings(sky).holdings)
  assert.deepEqual(off.rejected, [
    { id: "fea-sky-v6", code: "holding.unknownBridge", detail: `base ${SHARE_PORTAL}` },
  ])
  assert.deepEqual(deploymentHoldings(sky, [{ ...SKY, id: "fea-swap-v6" }]).rejected, [
    { id: "fea-swap-v6", code: "holding.unsupported", detail: "fea-swap-v6" },
  ])
})

test("with the profile's savings portals, Sky is the default only when they name it", () => {
  const read = pinnedTo({ "fea-sky-v6": skyFeature() })

  assert.equal(pinnedHoldings(read).listedByDefault, "fea-sky-v6")
  assert.equal(pinnedHoldings(read, [SKY]).listedByDefault, "fea-sky-v6")
  const unnamed = pinnedHoldings(read, [])
  assert.equal(unnamed.listedByDefault, undefined)
  assert.equal(unnamed.holdings.length, 1)
})

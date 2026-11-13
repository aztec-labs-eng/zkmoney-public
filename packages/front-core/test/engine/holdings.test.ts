// @vitest-environment node
import { describe, expect, it } from "vitest"
import {
  deploymentHoldings,
  holdingCatalog,
  pinnedHoldings,
  pinnedOxideDeployment,
  type Holding,
  type OxideBridge,
} from "@obsidion/core/oxide"
import type { OxideEnvTuple } from "@obsidion/core/types"
import type { BalanceEntry } from "../../src/engine/balances"
import { selectHoldings } from "../../src/engine/holdings"
import type { RecordSet } from "../../src/engine/persistentStore"
import prod from "../fixtures/oxideReleases.v6-prod.json"
import staging from "../fixtures/oxideReleases.v6-staging.json"
import main from "../fixtures/skySavings.main.json"

const SCOPE = "sandbox:0xaccount"

const bridge = (l2Token: string, underlying = `0x${l2Token.slice(2, 4).repeat(20)}`) =>
  ({
    underlying,
    token: underlying,
    portal: underlying,
    l2Token,
    tuple: {} as OxideEnvTuple,
  } as OxideBridge)

const holding = (id: string, l2Token: string): Holding => ({
  id,
  kind: "yield",
  l2Token,
  base: bridge("0xda"),
  held: bridge(l2Token),
  terms: "erc4626",
  conversion: "DaiUsds",
  rail: "skyEscrow",
  escrow: { factory: "0xfa", withdrawalExecutor: "0xec" },
})

const balances = (...held: [token: string, atomic: bigint, scope?: string][]) =>
  ({
    records: held.map(([token, atomic, scope = SCOPE]) => ({ scope, token, atomic })),
    loaded: true,
    failed: false,
  } satisfies RecordSet<BalanceEntry>)

const SKY = holding("fea-sky-v6", "0x5a")
const SKY_OLD = holding("fea-sky-v5", "0x5a")
const VAULT = holding("fea-vault-v6", "0x7b")
const SPARK = holding("fea-spark-v6", "0x9c")

const lines = (catalog: Holding[], deployment: Holding[], held: RecordSet<BalanceEntry>) =>
  selectHoldings({ holdings: catalog }, { holdings: deployment, rejected: [] }, held, SCOPE).map(
    ({ id, exitOnly, holdingIds }) => ({ id, exitOnly, holdingIds }),
  )

describe("selectHoldings", () => {
  it("shows every listed holding in profile order, held or not", () => {
    expect(lines([VAULT, SKY], [SKY, VAULT], balances([SKY.l2Token, 5n]))).toEqual([
      { id: VAULT.id, exitOnly: false, holdingIds: [VAULT.id] },
      { id: SKY.id, exitOnly: false, holdingIds: [SKY.id] },
    ])
  })

  it("shows a delisted holding the account holds as exit-only, after the listed ones", () => {
    const held = balances([VAULT.l2Token.toUpperCase(), 1n], [SPARK.l2Token, 0n])
    expect(lines([SKY], [VAULT, SKY, SPARK], held)).toEqual([
      { id: SKY.id, exitOnly: false, holdingIds: [SKY.id] },
      { id: VAULT.id, exitOnly: true, holdingIds: [VAULT.id] },
    ])
  })

  it("hides a delisted holding with no shares, or with shares only in another account", () => {
    expect(lines([SKY], [SKY, VAULT], balances([VAULT.l2Token, 0n]))).toHaveLength(1)
    expect(lines([SKY], [SKY, VAULT], balances([VAULT.l2Token, 9n, "other"]))).toHaveLength(1)
    expect(lines([], [SKY, VAULT], { records: [], loaded: false, failed: false })).toEqual([])
  })

  it("keeps one line for two holdings on one token, naming both as its moves' holdings", () => {
    const held = balances([SKY.l2Token, 3n])
    expect(lines([SKY], [SKY_OLD, SKY], held)).toEqual([
      { id: SKY.id, exitOnly: false, holdingIds: [SKY_OLD.id, SKY.id] },
    ])
    expect(lines([], [SKY_OLD, SKY], held)).toEqual([
      { id: SKY_OLD.id, exitOnly: true, holdingIds: [SKY_OLD.id, SKY.id] },
    ])
  })
})

/** Sky savings as `main`'s wallet read them on a manifest, pinned to `portal`. */
interface MainCase {
  manifest: "staging" | "prod"
  variant?: keyof typeof main.variants
  portal: string
  sky: Record<"main" | "savings" | "factory" | "executor" | "dai" | "sUsds", string> | null
}

describe("a profile that names no holdings", () => {
  const manifestOf = ({ manifest, variant }: MainCase): unknown => {
    if (!variant) return { staging, prod }[manifest]
    return { ...prod, deployments: [{ ...prod.deployments[0], features: main.variants[variant] }] }
  }
  const holdingsOf = (recorded: MainCase) =>
    pinnedHoldings(pinnedOxideDeployment(manifestOf(recorded), { portal: recorded.portal }))
  const PROD = holdingsOf({
    manifest: "prod",
    portal: prod.deployments[0]!.bridges[0]!.portal,
    sky: null,
  })

  it.each(main.cases as MainCase[])(
    "lists the Sky savings main's wallet reads on $manifest $variant pinned to $portal, or none",
    (recorded) => {
      const deployment = holdingsOf(recorded)
      const lines = selectHoldings(
        holdingCatalog(deployment, undefined),
        deployment,
        balances(),
        SCOPE,
      )
      const listed = lines.map((line) => ({
        main: line.base.portal,
        savings: line.held.portal,
        factory: line.rail === "skyEscrow" ? line.escrow.factory : undefined,
        executor: line.rail === "skyEscrow" ? line.escrow.withdrawalExecutor : undefined,
        dai: line.base.underlying,
        sUsds: line.held.underlying,
        exitOnly: line.exitOnly,
      }))
      expect(listed).toEqual(recorded.sky ? [{ ...recorded.sky, exitOnly: false }] : [])
    },
  )

  it("lists none under an empty list, where held shares can still leave", () => {
    const [sky] = PROD.holdings
    expect(selectHoldings(holdingCatalog(PROD, []), PROD, balances(), SCOPE)).toEqual([])
    const held = balances([sky!.l2Token, 4n])
    expect(
      selectHoldings(holdingCatalog(PROD, []), PROD, held, SCOPE).map((line) => line.exitOnly),
    ).toEqual([true])
  })
})

describe("the committed staging and production manifests", () => {
  const deployments = (manifest: typeof staging | typeof prod) =>
    manifest.deployments.map(
      (entry) => pinnedOxideDeployment(manifest, { portal: entry.bridges[0]!.portal }).deployment,
    )

  it("hold only their Sky features, and reject none", () => {
    const read = [...deployments(staging), ...deployments(prod)].map((d) => {
      const { holdings, rejected } = deploymentHoldings(d)
      return { holdings: holdings.map((h) => [h.id, h.rail]), rejected }
    })
    expect(read).toEqual([
      { holdings: [["fea-sky-v6", "skyEscrow"]], rejected: [] },
      { holdings: [["fea-sky-v6b", "skyEscrow"]], rejected: [] },
      { holdings: [["fea-sky-v6", "skyEscrow"]], rejected: [] },
    ])
  })

  it("read a vault on staging's dep-v6b through its fea-multistep-v6c executor", () => {
    const entry = staging.deployments[1]!
    const executor = entry.features["fea-multistep-v6c"]!
    const vault = (conversion: string) => ({
      project: "position",
      bridges: { main: "brg-tst-v6b", position: "brg-susds-v6b" },
      contracts: {},
      variables: { conversion },
    })
    const withVaults = {
      ...staging,
      deployments: [
        staging.deployments[0],
        {
          ...entry,
          features: {
            ...entry.features,
            "fea-vault-psm-v6b": vault("Psm"),
            "fea-vault-susds-v6b": vault("DaiUsds"),
          },
        },
      ],
    }
    const { deployment } = pinnedOxideDeployment(withVaults, { portal: entry.bridges[1]!.portal })
    const { holdings, rejected } = deploymentHoldings(deployment)

    const [, psm] = holdings
    expect(psm?.rail === "executor" && psm.executor).toEqual({
      id: "fea-multistep-v6c",
      address: executor.contracts.multiStepExecutor,
      adapters: {
        across: executor.contracts.acrossAdapter,
        cctp: executor.contracts.cctpAdapter,
        curve: executor.contracts.curveAdapter,
        erc4626: executor.contracts.erc4626Adapter,
        lifiIntent: executor.contracts.lifiIntentAdapter,
        makerPsm: executor.contracts.makerPsmAdapter,
        portalDeposit: executor.contracts.portalDepositAdapter,
        uniswapV3: executor.contracts.uniswapV3Adapter,
        weth: executor.contracts.wethAdapter,
      },
    })
    // Staging's executor has no Sky converter, so a DAI-to-USDS vault cannot run there.
    const missing = ["fea-multistep-v6c", "skyConverterAdapter"].join(" ")
    expect(rejected).toEqual([
      {
        id: "fea-vault-susds-v6b",
        code: "holding.unusableAddress",
        detail: missing,
      },
    ])
  })
})

// @vitest-environment node
import { describe, expect, it } from "vitest"
import type { Holding, OxideBridge } from "@obsidion/core/oxide"
import type { OxideEnvTuple } from "@obsidion/core/types"
import type { BalanceEntry } from "../../src/engine/balances"
import { selectHoldings } from "../../src/engine/holdings"
import type { RecordSet } from "../../src/engine/persistentStore"

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

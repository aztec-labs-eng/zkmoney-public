// @vitest-environment node
import {
  holdingCatalog,
  pinnedHoldings,
  pinnedOxideDeployment,
  type DeploymentHoldings,
} from "@obsidion/core/oxide"
import {
  boundRails,
  derived,
  memoryStore,
  recoverableRails,
  service,
  type BalanceEntry,
  type BoundRail,
  type MoveRecord,
  type MovesAccount,
  type RecordSet,
} from "@obsidion/front-core"
import { describe, expect, it } from "vitest"
import prod from "../../../../front-core/test/fixtures/oxideReleases.v6-prod.json"
import staging from "../../../../front-core/test/fixtures/oxideReleases.v6-staging.json"
import { liveMoveRails, moveRails } from "../../../src/features/savings/movesSession"

type Routes = Parameters<typeof moveRails>[2]

/** Ports that count how many executor ports were built. */
const countingRoutes = () => {
  const built = { executorPorts: 0 }
  const routes: Routes = {
    sky: () => ({ rail: "skyEscrow" } as ReturnType<Routes["sky"]>),
    executor: () => {
      built.executorPorts += 1
      return { rail: "executor" } as ReturnType<Routes["executor"]>
    },
  }
  return { routes, built }
}

/** Each bound rail, with its holdings and the ones that take a move in. */
const shown = (rails: readonly BoundRail[]) =>
  rails.map((rail: BoundRail) =>
    rail((r) => ({
      rail: r.routes.rail,
      holdings: r.holdings.map((h) => h.id),
      listed: r.holdings.filter((h) => r.listed.has(h.id)).map((h) => h.id),
    })),
  )

/** The rails `listed` binds over `deployment` for an account that holds no vault. */
const bind = (deployment: DeploymentHoldings, listed: readonly string[] | undefined) => {
  const { routes, built } = countingRoutes()
  const { holdings } = holdingCatalog(deployment, listed)
  const rails = shown(moveRails(deployment.holdings, holdings, routes, false)).map(
    ({ rail, holdings }) => ({ rail, holdings }),
  )
  return { rails, executorPorts: built.executorPorts }
}

const pinned = (manifest: unknown, portal: string) =>
  pinnedHoldings(pinnedOxideDeployment(manifest, { portal }))

/** Staging's second deployment with a `Psm` vault on its own bridge. */
function withVault(): DeploymentHoldings {
  const entry = staging.deployments[1]!
  const vault = {
    project: "position",
    bridges: { main: "brg-tst-v6b", position: "brg-susds-v6b" },
    contracts: {},
    variables: { conversion: "Psm" },
  }
  const manifest = {
    ...staging,
    deployments: [
      staging.deployments[0],
      { ...entry, features: { ...entry.features, "fea-vault-psm-v6b": vault } },
    ],
  }
  return pinned(manifest, entry.bridges[1]!.portal)
}

describe("moveRails", () => {
  const committed = [staging, prod].flatMap((manifest) =>
    manifest.deployments.map((entry) => pinned(manifest, entry.bridges[0]!.portal)),
  )

  it("binds only the Sky rail on every committed staging and production deployment", () => {
    for (const deployment of committed) {
      const sky = deployment.holdings.map((h) => h.id)
      for (const listed of [undefined, [], sky]) {
        expect(bind(deployment, listed)).toEqual({
          rails: [{ rail: "skyEscrow", holdings: sky }],
          executorPorts: 0,
        })
      }
    }
  })

  it("binds the executor rail only when the profile lists a vault on it", () => {
    const deployment = withVault()
    expect(bind(deployment, ["fea-sky-v6b"])).toEqual({
      rails: [{ rail: "skyEscrow", holdings: ["fea-sky-v6b"] }],
      executorPorts: 0,
    })
    expect(bind(deployment, ["fea-vault-psm-v6b"])).toEqual({
      rails: [
        { rail: "skyEscrow", holdings: ["fea-sky-v6b"] },
        { rail: "executor", holdings: ["fea-vault-psm-v6b"] },
      ],
      executorPorts: 1,
    })
  })
})

describe("liveMoveRails", () => {
  const SCOPE = "sandbox:0xacc"
  const VAULT = "fea-vault-psm-v6b"
  const SKY = "fea-sky-v6b"
  const deployment = withVault()
  const shareToken = deployment.holdings.find((h) => h.id === VAULT)!.l2Token
  const move = (phase: MoveRecord["phase"]) =>
    ({ id: "m1", holdingId: VAULT, rail: "executor", direction: "in", phase } as MoveRecord)
  const loaded = <T>(records: T[]): RecordSet<T> => ({ records, loaded: true, failed: false })

  /** The profile lists only Sky; the account's moves and share balances are stores. */
  const live = (moves: MoveRecord[], shares: bigint) => {
    const { routes, built } = countingRoutes()
    const movesStore = memoryStore(loaded(moves))
    const entry: BalanceEntry = {
      scope: SCOPE,
      token: shareToken,
      atomic: shares,
      updatedAt: 1,
    } as BalanceEntry
    const balances = memoryStore(loaded([entry]))
    const { holdings: listed } = holdingCatalog(deployment, [SKY])
    const sighted = memoryStore(false)
    const rails = liveMoveRails(deployment.holdings, listed, routes, {
      moves: movesStore.readonly,
      balances: balances.readonly,
      sighted: sighted.readonly,
      scope: SCOPE,
    })
    return { rails, built, movesStore, balances, sighted }
  }

  const SKY_ONLY = [{ rail: "skyEscrow", holdings: [SKY], listed: [SKY] }]
  // An unlisted vault's funds can leave, and a move in is refused (`move.exitOnly`).
  const EXIT_ONLY = [...SKY_ONLY, { rail: "executor", holdings: [VAULT], listed: [] }]

  it("binds an unlisted vault's rail, exit-only, while the account has an unfinished move on it", () => {
    const { rails, built, movesStore } = live([move("burned")], 0n)
    expect(shown(rails.get())).toEqual(EXIT_ONLY)
    expect(built.executorPorts).toBe(1)
    movesStore.set(loaded([move("claimed")]))
    expect(shown(rails.get())).toEqual(SKY_ONLY)
  })

  it("binds an unlisted vault's rail, exit-only, while the account holds its shares", () => {
    const { rails, built } = live([], 5n)
    expect(shown(rails.get())).toEqual(EXIT_ONLY)
    expect(built.executorPorts).toBe(1)
  })

  it("binds an unlisted vault's rail, exit-only, once the rescan sights a burn the moves engine may own", () => {
    const { rails, built, sighted } = live([], 0n)
    expect(shown(rails.get())).toEqual(SKY_ONLY)
    sighted.set(true)
    expect(shown(rails.get())).toEqual(EXIT_ONLY)
    expect(built.executorPorts).toBe(1)
  })

  it("binds no executor rail for a sighting on a deployment with no vault", () => {
    const { routes, built } = countingRoutes()
    const sky = pinned(staging, staging.deployments[0]!.bridges[0]!.portal)
    const none = memoryStore(loaded<never>([]))
    const rails = liveMoveRails(sky.holdings, holdingCatalog(sky, undefined).holdings, routes, {
      moves: none.readonly,
      balances: none.readonly,
      sighted: memoryStore(true).readonly,
      scope: SCOPE,
    })
    expect(shown(rails.get()).map((bound) => bound.rail)).toEqual(["skyEscrow"])
    expect(built.executorPorts).toBe(0)
  })

  it("binds no executor rail and builds no executor port for an account with neither", () => {
    const { rails, built, balances } = live([move("claimed")], 0n)
    expect(shown(rails.get())).toEqual(SKY_ONLY)
    // Shares on another account's scope are not this account's.
    const other = { scope: "sandbox:0xother", token: shareToken, atomic: 5n, updatedAt: 1 }
    balances.set(loaded([other as BalanceEntry]))
    expect(shown(rails.get())).toEqual(SKY_ONLY)
    expect(built.executorPorts).toBe(0)
  })

  it("keeps the same rails, and one executor port, while what it binds is unchanged", () => {
    const { rails, built, movesStore } = live([move("burned")], 5n)
    const first = rails.get()
    movesStore.set(loaded([move("depositSeen")]))
    expect(rails.get()).toBe(first)
    movesStore.set(loaded([]))
    expect(rails.get()).toBe(first)
    expect(built.executorPorts).toBe(1)
  })
})

describe("boundRails", () => {
  const SCOPE = "sandbox:0xacc"
  const deployment = withVault()
  const shareToken = deployment.holdings.find((h) => h.id === "fea-vault-psm-v6b")!.l2Token
  const loaded = <T>(records: T[]): RecordSet<T> => ({ records, loaded: true, failed: false })

  it("offers an unlisted vault's recovery once its shares arrive after the ports are built", async () => {
    const recover = async () => ({ to: shareToken, data: "0x" as const })
    const routes: Routes = {
      sky: () => ({ rail: "skyEscrow", recover } as unknown as ReturnType<Routes["sky"]>),
      executor: () => ({ rail: "executor", recover } as unknown as ReturnType<Routes["executor"]>),
    }
    const moves = memoryStore(loaded<MoveRecord>([]))
    const balances = memoryStore(loaded<BalanceEntry>([]))
    const { holdings: listed } = holdingCatalog(deployment, ["fea-sky-v6b"])
    const account = {
      moves: moves.readonly,
      balances: balances.readonly,
      sighted: memoryStore(false).readonly,
    }
    const rails = liveMoveRails(deployment.holdings, listed, routes, { ...account, scope: SCOPE })
    const ports = service("movePorts", { from: [], retry: "manual" }, async () => ({
      rails,
      account: {} as MovesAccount,
    }))
    await ports.ready()
    const recoverable = derived([boundRails(ports)], recoverableRails)
    const seen: ReadonlySet<string>[] = []
    recoverable.subscribe(() => seen.push(recoverable.get()))
    expect([...recoverable.get()]).toEqual(["skyEscrow"])
    const entry = { scope: SCOPE, token: shareToken, atomic: 5n, updatedAt: 1 } as BalanceEntry
    balances.set(loaded([entry]))
    expect([...recoverable.get()]).toEqual(["skyEscrow", "executor"])
    await Promise.resolve()
    expect(seen.map((rails) => [...rails])).toEqual([["skyEscrow", "executor"]])
  })
})

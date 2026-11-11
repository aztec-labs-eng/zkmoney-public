import { service, type QueryEntry } from "@obsidion/front-core"
import type { PageChain } from "../../src/session/pageChain"
import { testQuery } from "./query"

type Field = {
  [K in keyof PageChain]: PageChain[K] extends QueryEntry<unknown> ? K : never
}[keyof PageChain]
const FIELDS: Record<Field, true> = {
  oxideTuple: true,
  oxideDeployment: true,
  feeTokenBridgeTuple: true,
  deploymentTable: true,
  manifestBridges: true,
  retiredRollupSources: true,
  otherManifestSources: true,
  manifestDeployments: true,
  oxideEnv: true,
  currentTxAmountCap: true,
  activeWithdrawalExecutor: true,
  skySavings: true,
  savingsTuple: true,
}

/** Members that are no read: a fake for one stands as given. */
const PLAIN = new Set([
  "invalidateDeployment",
  "broadcasterArtifact",
  "ensClient",
  "ensName",
  "teeSignerOfToken",
])

/** Members that are services: each ask builds one over its fake. */
const SERVICES = new Set(["withdrawalRails", "swapSimulator", "connectFleetSigner"])

/** Page reads over fakes of their reads: each read calls its fake again, an undefined answer as null. */
export const fakeReads = (fakes: Record<string, (...args: never[]) => unknown>) => {
  const query = testQuery()
  return Object.fromEntries(
    Object.entries(fakes).map(([name, fake]) => {
      const read = (...args: never[]) =>
        query<[], unknown>(name, { load: async () => (await fake(...args)) ?? null, stale: 0 })()
      const asked = (...args: never[]) =>
        service(name, { from: [], retry: "manual" }, async () => fake(...args))
      const member = PLAIN.has(name)
        ? fake
        : SERVICES.has(name)
        ? asked
        : name in FIELDS
        ? read()
        : read
      return [name, member]
    }),
  ) as unknown as PageChain
}

/** Puts {@link fakeReads} over `fakes` in place of `reads`' own. */
export const assignReads = (reads: PageChain, fakes: Parameters<typeof fakeReads>[0]) =>
  Object.assign(reads, fakeReads(fakes))

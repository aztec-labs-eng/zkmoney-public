// @vitest-environment node
// What an account session's tasks read from its deps when they run, not when they are built.
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  encodeRecord,
  fixed,
  memoryBackend,
  openDatabase,
  registrationId,
} from "@obsidion/front-core"
import { pageSessionDeps } from "../../src/app/sessionDeps"
import type { WebWalletConfig } from "../../src/config/env"
import { sessionTasks } from "../../src/app/sessionTasks"
import { setUpgradeStatus } from "../../src/features/migration/migrationDialog"
import { checkUpgradeLock } from "../../src/features/migration/upgradeLock"
import { stashClaimLink } from "../../src/features/paylink/claimStash"
import { linkIdentity } from "../../src/features/paylink/linkIdentity"
import { TICKET_CLAIM_IO } from "../../src/features/paylink/ticketClaim"
import { tabStash } from "../../src/platform/storage/tabStash"
import { openSession, type SessionDeps } from "../../src/session/session"
import { PAYLINK_FRAGMENT } from "../fixtures/scanPayloads"
import { testPage } from "../support/page"
import { pendingRecord } from "../support/registrationFixtures"

type Core = Parameters<SessionDeps["features"]>[0]
const WALLET = { networkId: "0xnet" }
const L2_ADDRESS = `0x${"0a".repeat(32)}` as const
const ACCOUNT = { getAddress: () => ({ toString: () => L2_ADDRESS }) }
const ends: (() => void)[] = []
afterEach(() => {
  for (const end of ends.splice(0)) end()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** An account's session whose wallet, account and token are ready, running only `names`. */
function open(names: string[], over: Partial<Core> = {}, sessionOver: Partial<SessionDeps> = {}) {
  let services: ReturnType<typeof sessionTasks>["services"] | undefined
  let tasks: ReturnType<typeof sessionTasks>["tasks"] = []
  const features = (core: Core) => {
    const ready = {
      ...core,
      account: fixed("account", ACCOUNT),
      token: fixed("token", {}),
      ...over,
    }
    const real = sessionTasks(ready as unknown as Core)
    services = real.services
    tasks = real.tasks.filter((t) => names.includes(t.name))
    return { ...real, tasks }
  }
  const page = pageSessionDeps(testPage())({ id: "a", prefix: "a." })
  const previous = {
    serve: () => () => {},
    locate: vi.fn(async () => undefined),
    registeredAddress: async () => undefined,
    readHistory: async () => true,
  }
  const deps: SessionDeps = {
    ...page,
    database: openDatabase(memoryBackend()),
    wallet: fixed("wallet", WALLET) as never,
    signIn: { ...page.signIn!, previousAccount: previous },
    features,
    ...sessionOver,
  }
  const activeSince = vi.spyOn(deps.page.activeSince, "get").mockReturnValue(5)
  const getSecretKey = vi.spyOn(deps.auth, "getSecretKey").mockResolvedValue(undefined as never)
  const session = openSession(deps)
  ends.push(session.close)
  return { session, services: services!, tasks, previous, activeSince, getSecretKey }
}

describe("an account session's tasks", () => {
  it("look for the previous account through the page's watcher, in the session's wallet", async () => {
    const { previous } = open(["previousAccountFind"])
    await vi.waitFor(() => expect(previous.locate).toHaveBeenCalledWith(WALLET))
  })

  it("end the operations interrupted before the tab became active, as of that time", async () => {
    const { activeSince } = open(["interruptedSweep"])
    activeSince.mockClear()
    await vi.waitFor(() => expect(activeSince).toHaveBeenCalledOnce())
  })

  it("hold no SIPA keys while the page's auth has no secret key to derive them from", async () => {
    const { services, getSecretKey } = open([])
    await vi.waitFor(() => expect(getSecretKey).toHaveBeenCalledOnce())
    expect(services.sipaKeys!.get()).toEqual({ status: "pending" })
  })

  // The claim's cadence is a poll of the chain: a change on the page itself has to run it.
  it.each([
    ["its signup's registration is saved", false, async () => {}],
    [
      "the account's upgrade lock is read",
      true,
      (config: WebWalletConfig) => checkUpgradeLock(config, L2_ADDRESS),
    ],
    [
      "the upgrade check ends",
      true,
      async () => setUpgradeStatus({ state: "none", registration: false }),
    ],
  ])("pass the ticket claim again once %s, ahead of its cadence", async (_, saved, change) => {
    const tab = new Map<string, string>()
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => tab.get(key) ?? null,
      setItem: (key: string, value: string) => void tab.set(key, value),
      removeItem: (key: string) => void tab.delete(key),
    })
    vi.stubGlobal("location", { origin: "https://wallet.test" })
    vi.stubGlobal("fetch", async () => Promise.reject(new Error("offline")))
    stashClaimLink(tabStash, PAYLINK_FRAGMENT)
    tab.set(
      `obsidion.link-read:${linkIdentity(PAYLINK_FRAGMENT)}`,
      JSON.stringify({
        url: "u",
        fragment: PAYLINK_FRAGMENT,
        status: "unclaimed",
        flavor: "direct",
      }),
    )
    // Read on each pass that finds the signup ready for its claim.
    const chainSeconds = vi.spyOn(TICKET_CLAIM_IO, "chainSeconds").mockResolvedValue(0)
    const { session, tasks } = open(
      ["ticketClaim"],
      { teeSigner: fixed("teeSigner", {}) as never },
      { contractService: fixed("contractService", {}) as never },
    )
    ends.push(() => setUpgradeStatus({ state: "checking", registration: false }))
    await Promise.all([session.registrations.ready, session.withdrawals.ready])
    const record = pendingRecord({
      l2Address: L2_ADDRESS,
      terms: {
        deadline: Math.floor(Date.now() / 1000) + 3_600,
        fee: "1",
        minDeposit: "0",
        paylinkFunded: true,
        paylinkId: linkIdentity(PAYLINK_FRAGMENT),
      },
    })
    const save = () =>
      session.db.write(async (w) =>
        w.put(`acct/registrations/${registrationId(record.sipaAddress)}`, encodeRecord(record)),
      )
    if (saved) await save()
    await session.wake(tasks[0]!)
    const passes = chainSeconds.mock.calls.length
    await (saved ? change(session.page.config) : save())
    await vi.waitFor(() => expect(chainSeconds.mock.calls.length).toBeGreaterThan(passes))
  })
})

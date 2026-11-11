// @vitest-environment node
// What an account session's tasks read from its deps when they run, not when they are built.
import { afterEach, describe, expect, it, vi } from "vitest"
import { fixed, memoryBackend, openDatabase } from "@obsidion/front-core"
import { pageSessionDeps } from "../../src/app/sessionDeps"
import { sessionTasks } from "../../src/app/sessionTasks"
import { openSession, type SessionDeps } from "../../src/session/session"
import { testPage } from "../support/page"

type Core = Parameters<SessionDeps["features"]>[0]
const WALLET = { networkId: "0xnet" }
const ACCOUNT = { getAddress: () => ({ toString: () => `0x${"0a".repeat(32)}` }) }
const ends: (() => void)[] = []
afterEach(() => {
  for (const end of ends.splice(0)) end()
})

/** An account's session whose wallet, account and token are ready, running only `names`. */
function open(names: string[]) {
  let services: ReturnType<typeof sessionTasks>["services"] | undefined
  const features = (core: Core) => {
    const ready = { ...core, account: fixed("account", ACCOUNT), token: fixed("token", {}) }
    const real = sessionTasks(ready as unknown as Core)
    services = real.services
    return { ...real, tasks: real.tasks.filter((t) => names.includes(t.name)) }
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
  }
  const activeSince = vi.spyOn(deps.page.activeSince, "get").mockReturnValue(5)
  const getSecretKey = vi.spyOn(deps.auth, "getSecretKey").mockResolvedValue(undefined as never)
  const session = openSession(deps)
  ends.push(session.close)
  return { session, services: services!, previous, activeSince, getSecretKey }
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
})

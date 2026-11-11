// Guards: no save of a changed or cancelled verification; a stale lookup never wins.
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest"
import { setIdentity } from "../../support/identity"
import type { RegistryTagResolution } from "@obsidion/front-core"

const mocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  fresh: vi.fn(),
  probe: vi.fn(),
}))
vi.mock("../../../src/features/registration/nameAvailability", () => ({
  probeNameAvailability: mocks.probe,
}))
vi.mock("../../../src/features/contacts/registryResolution", () => ({
  resolveTagViaRegistry: mocks.resolve,
  resolveTagForCommit: mocks.fresh,
}))
import { useInlineContactSearch } from "../../../src/features/contacts/useInlineContactSearch"

const hit = (address = "0xalice"): RegistryTagResolution => ({
  status: "resolved",
  account: "0x00000000000000000000000000000000000000aa",
  l2Address: address,
  rollupId: "r1",
  sipaStealthPublicKey: { x: 1n, y: 2n },
  xmtpAddress: "0x00000000000000000000000000000000000000b0",
})
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
let current: ReturnType<typeof useInlineContactSearch>
const rows: [] = []
function Probe({ query }: { query: string }) {
  current = useInlineContactSearch(rows, query)
  return (
    <p>
      {current.panel.kind} {current.isSaving ? "busy" : "ready"} {current.saveError}
    </p>
  )
}

const { openTestSession } = await import("../../support/session")
const { testContacts } = await import("../../support/contacts")
const { closeSession } = await import("../../../src/session/session")
let add: MockInstance
beforeEach(async () => {
  const contacts = testContacts()
  add = vi.spyOn(contacts, "addEntry")
  openTestSession({ contacts })
  await setIdentity({ handle: "me" })
})
afterEach(closeSession)

describe("shared inline contact verification", () => {
  let root: Root
  let container: HTMLDivElement
  const render = async (query: string) => {
    await act(async () => root.render(<Probe query={query} />))
  }
  const resolveQuery = async (query = "alice") => {
    await render(query)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })
  }
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    mocks.resolve.mockResolvedValue(hit())
    mocks.fresh.mockResolvedValue(hit())
    add.mockResolvedValue(undefined)
    mocks.probe.mockResolvedValue({ status: "unknown", grantValid: false, grantBound: false })
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.useRealTimers()
  })

  it("never saves a cached address that fresh verification changed", async () => {
    await resolveQuery()
    mocks.fresh.mockResolvedValue(hit("0xrotated"))
    await act(async () => {
      await current.save("alice")
    })
    expect(add).not.toHaveBeenCalled()
    expect(current.saveError).toContain("Contact details changed")
    expect(mocks.resolve).toHaveBeenCalledTimes(2)
  })

  it.each(["edit", "dismiss", "unmount"])(
    "does not persist when %s cancels pending verification",
    async (operation) => {
      await resolveQuery()
      const fresh = deferred<RegistryTagResolution>()
      mocks.fresh.mockReturnValue(fresh.promise)
      let saving!: Promise<unknown>
      act(() => {
        saving = current.save("alice")
      })
      if (operation === "edit") await render("bob")
      if (operation === "dismiss") current.cancel()
      if (operation === "unmount") await act(async () => root.render(null))
      await act(async () => {
        fresh.resolve(hit())
        await saving
      })
      expect(add).not.toHaveBeenCalled()
    },
  )

  it("keeps the latest result across repeated edits with an earlier lookup in flight", async () => {
    const earlier = deferred<RegistryTagResolution>()
    mocks.resolve.mockReturnValueOnce(earlier.promise).mockResolvedValueOnce(hit("0xbob"))
    await resolveQuery("alice")
    expect(current.panel).toEqual({ kind: "looking-up", tag: "alice" })
    await resolveQuery("bob")
    await act(async () => earlier.resolve(hit()))
    expect(current.panel).toEqual({ kind: "add-offer", tag: "bob" })
  })
})

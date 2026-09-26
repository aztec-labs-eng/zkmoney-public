import { act, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@obsidion/web-ds", () => ({
  Icon: () => null,
  Spinner: () => null,
  PrimaryGradientButton: ({
    title,
    onClick,
    isDisabled,
  }: {
    title: string
    onClick?: () => void
    isDisabled?: boolean
  }) => (
    <button onClick={onClick} disabled={isDisabled}>
      {title}
    </button>
  ),
}))
vi.mock("../src/config/env", () => ({
  getConfig: () => ({ accountServiceUrl: "https://account.test/" }),
}))
vi.mock("../src/config/oxideTuple", () => ({
  getOxideTuple: async () => ({ ensDomain: "oxidestaging.eth" }),
  requireTupleField: (tuple: Record<string, string>, key: string) => tuple[key],
}))
vi.mock("../src/features/onboarding/OnboardingCard", () => ({
  OnboardingCard: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))
vi.mock("../src/features/onboarding/steps/SignupStepper", () => ({
  SignupStepper: () => null,
}))

const { probeNameAvailability } = await import("../src/features/onboarding/nameAvailability")
const { InvitationStep } = await import("../src/features/onboarding/steps/InvitationStep")
const { ChooseTagStep } = await import("../src/features/onboarding/steps/ChooseTagStep")

const answering = (body: unknown, status = 200) =>
  vi.fn(async (_url: string) => new Response(JSON.stringify(body), { status }))

describe("probeNameAvailability", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("hashes the tag against the wire domain and passes the service status through", async () => {
    const fetchMock = answering({ status: "reserved" })
    vi.stubGlobal("fetch", fetchMock)

    expect(await probeNameAvailability("satoshi")).toBe("reserved")
    const url = new URL(fetchMock.mock.calls[0][0])
    expect(url.origin + url.pathname).toBe("https://account.test/domain/available")
    expect(url.searchParams.get("nameHash")).toMatch(/^0x[0-9a-f]{64}$/)
  })

  it("folds the tag itself, so a caller that forgets cannot probe a stray node", async () => {
    const fetchMock = answering({ status: "available" })
    vi.stubGlobal("fetch", fetchMock)
    await probeNameAvailability("ABC-DEF")
    await probeNameAvailability("abc-def")
    const [a, b] = fetchMock.mock.calls.map((c) => new URL(c[0]).searchParams.get("nameHash"))
    expect(a).toBe(b)
  })

  it("reads a refusal, an unrecognised status and a dead network as unknown", async () => {
    vi.stubGlobal("fetch", answering({ error: "down" }, 503))
    expect(await probeNameAvailability("satoshi")).toBe("unknown")

    vi.stubGlobal("fetch", answering({ status: "maybe" }))
    expect(await probeNameAvailability("satoshi")).toBe("unknown")

    vi.stubGlobal("fetch", async () => {
      throw new Error("offline")
    })
    expect(await probeNameAvailability("satoshi")).toBe("unknown")
  })

  it("preserves both reservation and blocklist state", async () => {
    vi.stubGlobal("fetch", answering({ status: "reserved", blocked: true }))
    expect(await probeNameAvailability("admin")).toBe("blocked-reserved")
  })
})

/** The typed tag is probed while the user is still on the invitation step. */
describe("InvitationStep availability", () => {
  let container: HTMLDivElement
  let root: Root
  const onUnlock = vi.fn()

  const render = async (
    header: boolean = true,
    initialHandle?: string,
    resuming = false,
    allowBlocked = false,
  ) => {
    await act(async () => {
      root.render(
        <InvitationStep
          busy={false}
          header={header ? <span /> : undefined}
          initialHandle={initialHandle}
          checkAvailability
          allowBlocked={allowBlocked}
          resuming={resuming}
          onUnlock={onUnlock}
          onCancelSignIn={vi.fn()}
        />,
      )
    })
  }
  const cta = () => container.querySelector("button")!
  const type = async (value: string) => {
    const input = container.querySelector("input")!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
      setter.call(input, value)
      input.dispatchEvent(new Event("input", { bubbles: true }))
    })
  }
  /** Past the probe's debounce, with the answer applied. */
  const settle = async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 450))
    })
  }

  beforeEach(() => {
    vi.clearAllMocks()
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  })

  it("blocks a name held by another claim", async () => {
    vi.stubGlobal("fetch", answering({ status: "reserved" }))
    await render()
    await type("satoshi")
    await settle()

    expect(container.textContent).toContain("is being claimed by someone else")
    expect(cta().disabled).toBe(true)
    await act(async () => cta().click())
    expect(onUnlock).not.toHaveBeenCalled()
  })

  it("lets a reservation through when the signup is being resumed", async () => {
    vi.stubGlobal("fetch", answering({ status: "reserved" }))
    await render(true, undefined, true)
    await type("satoshi")
    await settle()

    // The probe knows the name is held, never by whom, so the line claims neither owner.
    expect(container.textContent).not.toContain("being claimed by someone else")
    expect(container.textContent).not.toContain("is yours")
    expect(container.textContent).toContain("Continue with your passkey to pick it back up")
    expect(cta().disabled).toBe(false)
    await act(async () => cta().click())
    expect(onUnlock).toHaveBeenCalledWith("satoshi")
  })

  it("still refuses a blocklisted name while resuming", async () => {
    vi.stubGlobal("fetch", answering({ status: "blocked" }))
    await render(true, undefined, true)
    await type("admin")
    await settle()

    expect(container.textContent).toContain("isn't available")
    expect(cta().disabled).toBe(true)
  })

  it("refuses a blocked reservation when resuming without a grant", async () => {
    vi.stubGlobal("fetch", answering({ status: "reserved", blocked: true }))
    await render(true, undefined, true)
    await type("admin")
    await settle()

    expect(container.textContent).toContain("isn't available")
    expect(container.textContent).not.toContain("Continue with your passkey")
    expect(cta().disabled).toBe(true)
  })

  it("blocks a blocklisted name", async () => {
    vi.stubGlobal("fetch", answering({ status: "blocked" }))
    await render()
    await type("admin")
    await settle()

    expect(container.textContent).toContain("isn't available")
    expect(cta().disabled).toBe(true)
  })

  it("lets a route grant pass a blocklisted name", async () => {
    vi.stubGlobal("fetch", answering({ status: "blocked" }))
    await render(true, undefined, false, true)
    await type("admin")
    await settle()

    expect(container.textContent).not.toContain("isn't available")
    expect(cta().disabled).toBe(false)
  })

  it("does not let a route grant pass a live reservation", async () => {
    vi.stubGlobal("fetch", answering({ status: "reserved" }))
    await render(true, undefined, false, true)
    await type("satoshi")
    await settle()

    expect(container.textContent).toContain("is being claimed by someone else")
    expect(cta().disabled).toBe(true)
  })

  it("still checks a blocked reservation when a grant is present", async () => {
    vi.stubGlobal("fetch", answering({ status: "reserved", blocked: true }))
    await render(true, undefined, false, true)
    await type("admin")
    await settle()

    expect(container.textContent).toContain("is being claimed by someone else")
    expect(cta().disabled).toBe(true)
  })

  it("lets the granted holder retry a blocked reservation", async () => {
    vi.stubGlobal("fetch", answering({ status: "reserved", blocked: true }))
    await render(true, undefined, true, true)
    await type("admin")
    await settle()

    expect(container.textContent).toContain("Continue with your passkey")
    expect(cta().disabled).toBe(false)
  })

  it("confirms a free name and lets it through", async () => {
    vi.stubGlobal("fetch", answering({ status: "available" }))
    await render()
    await type("satoshi")
    await settle()

    expect(container.textContent).toContain("is available")
    expect(cta().disabled).toBe(false)
    await act(async () => cta().click())
    expect(onUnlock).toHaveBeenCalledWith("satoshi")
  })

  it("stays out of the way when the service cannot answer", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("offline")
    })
    await render()
    await type("satoshi")
    // The read retries at 250ms and 500ms after the 350ms debounce.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1250))
    })

    expect(container.textContent).not.toContain("available")
    expect(cta().disabled).toBe(false)
  })

  it("spins while the answer is outstanding, then resolves to it", async () => {
    vi.stubGlobal("fetch", answering({ status: "available" }))
    await render()
    await type("satoshi")

    expect(container.textContent).toContain("Checking availability")
    expect(container.textContent).not.toContain("is available.")
    expect(cta().disabled).toBe(true)
    await act(async () => cta().click())
    expect(onUnlock).not.toHaveBeenCalled()

    await settle()
    expect(container.textContent).not.toContain("Checking availability")
    expect(container.textContent).toContain("@satoshi is available.")
    expect(cta().disabled).toBe(false)
  })

  it("holds back the valid-tag tick until the answer lands", async () => {
    vi.stubGlobal("fetch", answering({ status: "available" }))
    await render(false)
    await type("satoshi")

    expect(container.querySelector("[data-testid=handle-valid-check]")).toBeNull()
    expect(container.querySelector(".ww-invite__check")).not.toBeNull()

    await settle()
    expect(container.querySelector("[data-testid=handle-valid-check]")).not.toBeNull()
  })

  it("folds a typed tag to the case it will register under", async () => {
    const fetchMock = answering({ status: "available" })
    vi.stubGlobal("fetch", fetchMock)
    await render(false)
    await type("ABC-DEF")
    await settle()

    expect(container.querySelector("input")!.value).toBe("abc-def")
    expect(container.textContent).toContain("@abc-def is available.")
    // Registration hashes the tag as typed while every resolver normalises first, so an
    // uppercase tag would register under a hash nobody can pay to.
    const probed = new URL(fetchMock.mock.calls[0][0]).searchParams.get("nameHash")
    const lower = await probeNameAvailability("abc-def")
    expect(lower).toBe("available")
    expect(probed).toBe(
      new URL(fetchMock.mock.calls[fetchMock.mock.calls.length - 1][0]).searchParams.get(
        "nameHash",
      ),
    )
  })

  it("folds a seeded tag that never passes through the field", async () => {
    vi.stubGlobal("fetch", answering({ status: "available" }))
    // A claim link (/claim/:handle) seeds the input directly, bypassing onChange entirely.
    await render(false, "@ABC-DEF.zk.money")
    expect(container.querySelector("input")!.value).toBe("abc-def")
    expect(cta().disabled).toBe(true)

    await settle()
    expect(container.textContent).toContain("@abc-def is available.")
    expect(cta().disabled).toBe(false)
  })

  it("never probes a malformed tag", async () => {
    const fetchMock = answering({ status: "available" })
    vi.stubGlobal("fetch", fetchMock)
    await render()
    await type("not a tag!")
    await settle()

    expect(fetchMock).not.toHaveBeenCalled()
    expect(cta().disabled).toBe(true)
  })

  it("holds a seeded paylink tag while availability is pending", async () => {
    const onClaim = vi.fn()
    vi.stubGlobal("fetch", answering({ status: "available" }))
    await act(async () => {
      root.render(
        <ChooseTagStep
          initialHandle="alice"
          busy={false}
          onClaim={onClaim}
          onLogIn={vi.fn()}
          onCancel={vi.fn()}
          onClose={vi.fn()}
        />,
      )
    })
    expect(cta().disabled).toBe(true)
    await act(async () => cta().click())
    expect(onClaim).not.toHaveBeenCalled()

    await settle()
    expect(cta().disabled).toBe(false)
    await act(async () => cta().click())
    expect(onClaim).toHaveBeenCalledWith("alice")
  })

  it("keeps a blocked reservation out of the paylink flow without a grant", async () => {
    vi.stubGlobal("fetch", answering({ status: "reserved", blocked: true }))
    await act(async () => {
      root.render(
        <ChooseTagStep
          initialHandle="alice"
          busy={false}
          resuming
          onClaim={vi.fn()}
          onLogIn={vi.fn()}
          onCancel={vi.fn()}
          onClose={vi.fn()}
        />,
      )
    })
    await settle()
    expect(container.textContent).toContain("isn't available")
    expect(cta().disabled).toBe(true)
  })
})

import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi, beforeAll } from "vitest"
import { CLAIM_STASH_KEY } from "../src/features/paylink/claimStash"

const FRAGMENT = "abc123"
const BAD_FRAGMENT = "not-a-link"
const EMAIL_FRAGMENT = "email-link"
const { Unsupported } = vi.hoisted(() => ({ Unsupported: class extends Error {} }))

const navigate = vi.fn()
const showReportableError = vi.fn()
const emitLinkOpened = vi.fn()
let resolveViewLink: ((value: unknown) => void) | undefined
const viewLinkMock = vi.fn(
  (..._args: unknown[]) =>
    new Promise((resolve) => {
      resolveViewLink = resolve
    }),
)
const visitorStatus = vi.fn()

/** This browser's onboarded identity — null is a visitor, who gets the signup page instead. */
let identity: { handle: string; address: string } | null = null

// Stable identities: the screen memoizes its status deps off these.
const ROLLUP_ADDRESS = "0x" + "ab".repeat(20)
const aztec = { obsidionWallet: { node: {} }, rollupAddress: ROLLUP_ADDRESS }
const contracts = { contractService: {} }

const linkShape = (fragment: string, status = "unclaimed") => ({
  id: fragment,
  url: `http://test/link#${fragment}`,
  fragment,
  amount: "5",
  status,
  flavor: "direct",
  createdAt: 0,
})

vi.mock("react-router-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router-dom")>()),
  useNavigate: () => navigate,
}))
vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  useAztecContext: () => aztec,
  useContractServiceContext: () => contracts,
  NETWORK_STORAGE_KEY: "obsidion_network",
}))
vi.mock("../src/features/identity/walletIdentity", () => ({
  loadOnboardedIdentity: () => identity,
}))
vi.mock("../src/features/paylink/PaylinkVisitorScreen", () => ({
  PaylinkVisitorScreen: ({
    link,
    statusSettled,
  }: {
    link: { status: string; amount?: string }
    statusSettled: boolean
  }) => {
    visitorStatus(link.status)
    return (
      <div data-testid="visitor" data-settled={statusSettled}>
        {link.amount}
      </div>
    )
  },
}))
vi.mock("../src/features/paylink/sponsoredPaylink", () => ({
  decodeLink: (fragment: string) => {
    if (fragment === BAD_FRAGMENT) throw new Error("Invalid paylink link")
    if (fragment === EMAIL_FRAGMENT) throw new Unsupported()
    return linkShape(fragment)
  },
  EmailPaylinkUnsupportedError: Unsupported,
  viewLink: (...args: unknown[]) => viewLinkMock(...args),
  emitLinkOpened: (...args: unknown[]) => emitLinkOpened(...args),
}))
vi.mock("../src/errors/errorModal", () => ({ showReportableError }))
// The DS drags in liquid-glass optics jsdom can't render; the test is about which surface appears.
vi.mock("@obsidion/web-ds", () => ({
  AuroraBackground: () => null,
  GradientText: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
  Icon: () => null,
  Card: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  ScreenNavBar: () => null,
  Spinner: () => <div data-testid="spinner" />,
}))

const { LinkViewScreen } = await import("../src/features/paylink/LinkViewScreen")
import { seedBootConfig } from "./seedBootConfig"

describe("LinkViewScreen", () => {
  beforeAll(seedBootConfig)

  let container: HTMLDivElement
  let root: Root

  const render = async (fragment = FRAGMENT) => {
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={[`/link#${fragment}`]}>
          <LinkViewScreen />
        </MemoryRouter>,
      )
    })
  }
  const visitor = () => container.querySelector("[data-testid=visitor]")

  beforeEach(() => {
    vi.clearAllMocks()
    sessionStorage.clear()
    resolveViewLink = undefined
    identity = { handle: "creator", address: "0xself" }
    aztec.rollupAddress = ROLLUP_ADDRESS
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    resolveViewLink?.(linkShape(FRAGMENT))
    await act(async () => root.unmount())
    container.remove()
  })

  // Every onboarded browser claims on Home — the link's creator included; there is no
  // creator-side page on /link.
  it("hands an onboarded browser to Home's claim modal", async () => {
    await render()
    expect(sessionStorage.getItem(CLAIM_STASH_KEY)).toBe(FRAGMENT)
    expect(navigate).toHaveBeenCalledWith("/", { replace: true })
    expect(container.querySelector("[data-testid=spinner]")).not.toBeNull()
    expect(visitor()).toBeNull()
    expect(viewLinkMock).not.toHaveBeenCalled()
    // The Home surface emits link_opened; a handoff mount stays silent.
    expect(emitLinkOpened).not.toHaveBeenCalled()
  })

  it("keeps a fragment that does not decode on the malformed card", async () => {
    await render(BAD_FRAGMENT)
    expect(container.textContent).toContain("This link is malformed or incomplete")
    expect(navigate).not.toHaveBeenCalled()
    expect(sessionStorage.getItem(CLAIM_STASH_KEY)).toBeNull()
    expect(emitLinkOpened).not.toHaveBeenCalled()
  })

  it.each([
    ["an onboarded browser", { handle: "alice", address: "0x1" }],
    ["a visitor", null],
  ])("keeps %s on the unsupported card for an email link: no stash, no signup", async (_, who) => {
    identity = who
    await render(EMAIL_FRAGMENT)
    expect(container.textContent).toContain(
      "Email-locked payment links aren't supported in this wallet. Ask the sender for a new link.",
    )
    expect(visitor()).toBeNull()
    expect(navigate).not.toHaveBeenCalled()
    expect(sessionStorage.getItem(CLAIM_STASH_KEY)).toBeNull()
    expect(viewLinkMock).not.toHaveBeenCalled()
    expect(emitLinkOpened).not.toHaveBeenCalled()
  })

  // A browser with no identity can't claim; the amount leads into signup instead.
  it("hands a visitor with no account to the signup page", async () => {
    identity = null
    await render()
    expect(visitor()).not.toBeNull()
    expect(navigate).not.toHaveBeenCalled()
  })

  it("keeps the signup page after this mount writes an identity", async () => {
    identity = null
    await render()
    identity = { handle: "alice", address: "0xself" }
    await render()
    expect(visitor()).not.toBeNull()
    expect(navigate).not.toHaveBeenCalled()
  })

  it("refines the visitor page's status from the chain without a passkey", async () => {
    identity = null
    await render()
    expect(viewLinkMock).toHaveBeenCalledTimes(1)
    expect(viewLinkMock.mock.calls[0]?.[0]).toEqual({
      wallet: aztec.obsidionWallet,
      contractService: contracts.contractService,
    })
    expect(visitorStatus).toHaveBeenLastCalledWith("unclaimed")
    await act(async () => resolveViewLink?.(linkShape(FRAGMENT, "claimed")))
    expect(visitorStatus).toHaveBeenLastCalledWith("claimed")
  })

  it("retries an unreadable escrow note before enabling the visitor voucher read", async () => {
    vi.useFakeTimers()
    try {
      identity = null
      await render()
      await act(async () => resolveViewLink?.({ ...linkShape(FRAGMENT), amount: undefined }))
      expect(visitor()?.textContent).toBe("")
      expect(visitor()?.getAttribute("data-settled")).toBe("false")
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000)
      })
      expect(viewLinkMock).toHaveBeenCalledTimes(2)
      await act(async () =>
        resolveViewLink?.({ ...linkShape(FRAGMENT), amount: "20", claimableFrom: 1 }),
      )
      expect(visitor()?.textContent).toBe("20")
      expect(visitor()?.getAttribute("data-settled")).toBe("true")
    } finally {
      vi.useRealTimers()
    }
  })

  // Claim-funnel top for the visitor page: exactly one link_opened per mounted fragment, as soon
  // as the network identity (part of the join key) is known.
  it("emits link_opened once per visitor fragment, as soon as the rollup address is known", async () => {
    identity = null
    await render()
    expect(emitLinkOpened).toHaveBeenCalledTimes(1)
    expect(emitLinkOpened).toHaveBeenCalledWith(ROLLUP_ADDRESS, FRAGMENT)
    await render() // re-render with the same fragment must not re-fire
    expect(emitLinkOpened).toHaveBeenCalledTimes(1)
  })

  it("holds link_opened until the rollup address hydrates", async () => {
    identity = null
    aztec.rollupAddress = ""
    await render()
    expect(emitLinkOpened).not.toHaveBeenCalled()
  })
})

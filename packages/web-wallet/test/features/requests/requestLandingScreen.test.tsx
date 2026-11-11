// Guards: no pay on a wrong rollup, node, payee or expired packet; a stale resolve never wins.
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import {
  MemoryRouter,
  Route,
  Routes,
  useLocation,
  useNavigate,
  type NavigateFunction,
} from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { setIdentity, seedOnboarded } from "../../support/identity"
import type { Address } from "viem"
import type { ChainIdentity } from "@obsidion/core/types"
import { encodeRequestInline, type RequestInlinePacket } from "@obsidion/front-core"
import { mockLoadDepositFacts, singleToken } from "../../support/depositTokens"
import { fmt } from "../../../src/lib/fmt"
import copy from "../../../src/features/requests/RequestLandingScreen.copy"
import { requesterMismatch } from "../../../src/features/requests/accountlessRequestErrors"

const SIPA = `0x${"aa".repeat(20)}`
const L1_TOKEN = `0x${"22".repeat(20)}`
const L2_TOKEN = `0x${"1b".repeat(32)}`
const ROLLUP = "0xrollup"
const PORTAL = `0x${"c".repeat(40)}`
const CHAIN_ID = 31337

function fragmentFor(over: Partial<RequestInlinePacket> = {}): string {
  return encodeRequestInline({
    requestId: `0x${"0a".repeat(32)}`,
    requesterTag: "alice",
    requesterAddress: `0x${"2c".repeat(32)}`,
    amountAtomic: 1_000_000n,
    tokenAddress: L2_TOKEN,
    tokenDecimals: 6,
    tokenSymbol: "DAI",
    networkId: ROLLUP,
    sipaAddress: SIPA,
    note: "Pizza dinner",
    ...over,
  })
}

const { resolve, tagLookup, portal, fireEvent } = vi.hoisted(() => ({
  fireEvent: vi.fn(),
  resolve: vi.fn(),
  tagLookup: vi.fn(),
  portal: vi.fn(),
}))

vi.mock("../../../src/lib/analytics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/lib/analytics")>()),
  fireEvent,
}))
vi.mock("../../../src/features/contacts/registryResolution", () => ({
  resolveTagForCommit: (_page: unknown, tag: string) => tagLookup(tag),
}))
vi.mock("../../../src/config/env", async () => {
  const { http } = await import("viem")
  return {
    l1Transport: () => http("http://127.0.0.1:8545"),
  }
})
vi.mock("../../../src/config/oxideTuple", () => ({
  requireTupleField: (tuple: Record<string, unknown>, key: string) => tuple[key],
  l1PublicClient: () => "l1-client",
}))
vi.mock("../../../src/features/sipa/loadDepositFacts", (importOriginal) =>
  mockLoadDepositFacts(importOriginal, () => singleToken(L1_TOKEN as Address)),
)
vi.mock("@obsidion/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/sdk")>()),
  readPortalChainIdentity: portal,
}))
vi.mock("../../../src/features/requests/accountlessRequest", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/features/requests/accountlessRequest")>()),
  resolveAccountlessRequest: resolve,
}))
// The sheet pulls wagmi/RainbowKit; the landing is what these cover.
vi.mock("../../../src/features/requests/ExternalWalletPayModal", () => ({
  ExternalWalletPayModal: ({
    onPaid,
    result,
  }: {
    onPaid?: () => void
    result: { paymentUri: string }
  }) => (
    <button data-uri={result.paymentUri} onClick={onPaid}>
      pay-sheet
    </button>
  ),
}))
vi.mock("@obsidion/web-ds", () => ({
  AuroraBackground: () => null,
  Card: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  GradientText: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
  Icon: () => null,
  PrimaryGradientButton: ({ title, onClick }: { title: string; onClick: () => void }) => (
    <button onClick={onClick}>{title}</button>
  ),
  ScreenNavBar: ({ title }: { title: string }) => <div>{title}</div>,
  Spinner: () => <div>spinner</div>,
  TopNavIconButton: ({ ariaLabel, onClick }: { ariaLabel: string; onClick: () => void }) => (
    <button aria-label={ariaLabel} onClick={onClick} />
  ),
}))

const { RequestLandingScreen } = await import("../../../src/features/requests/RequestLandingScreen")
const { L1IdentityUnavailableError } = await import("@obsidion/front-core")

const { openTestSession } = await import("../../support/session")
const { defaultConfig } = await import("../../support/page")
const config = {
  ...defaultConfig,
  oxideProfile: { ...defaultConfig.oxideProfile, portal: PORTAL },
  profileRollupVersion: "1",
}
/** The node's answer, agreeing with the portal; only the default node's L1-outage fallback boots on it. */
const getNodeInfo = vi.fn(async () => ({
  l1ChainId: CHAIN_ID,
  rollupVersion: 1,
  l1ContractAddresses: {
    rollupAddress: { toString: () => ROLLUP },
    inboxAddress: { toString: () => `0x${"b".repeat(40)}` },
  },
}))
const node = { getNodeInfo } as never

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

describe("RequestLandingScreen accountless landing", () => {
  let container: HTMLDivElement
  let root: Root
  let navigate: NavigateFunction
  function RouterControls() {
    navigate = useNavigate()
    return null
  }
  function SendProbe() {
    const { state } = useLocation()
    const request = (
      state as {
        request?: { amount: number; link?: string; standing?: boolean; requesterPin?: string }
      } | null
    )?.request
    return (
      <div data-testid="send" data-pin={request?.requesterPin}>{`send-sheet ${request?.amount} ${
        request?.link
      }${request?.standing ? " standing" : ""}`}</div>
    )
  }
  function EnterProbe() {
    const { state } = useLocation()
    return <div data-testid="enter-next">{(state as { next?: string } | null)?.next}</div>
  }

  beforeEach(async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    resolve.mockReset()
    fireEvent.mockReset()
    tagLookup.mockReset()
    tagLookup.mockImplementation(async (tag: string) => ({
      status: tag === "nobody" ? "notFound" : "resolved",
    }))
    portal.mockReset()
    portal.mockResolvedValue({
      l1ChainId: CHAIN_ID,
      rollupVersion: "1",
      rollupAddress: ROLLUP,
      inboxAddress: `0x${"b".repeat(40)}`,
    })
    await setIdentity(null)
    // The identity gate reads the passkey map from the open session's device keys.
    openTestSession({ config, primed: { tuple: { token: L1_TOKEN, l2Token: L2_TOKEN } as never } })
    config.endpoints = defaultConfig.endpoints
    getNodeInfo.mockClear()
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  async function render(
    fragment: string,
    strict = false,
    state?: object,
    pathname = "/request",
    chainIdentity?: ChainIdentity,
  ) {
    await act(async () => {
      const tree = (
        <MemoryRouter initialEntries={[{ pathname, hash: fragment ? `#${fragment}` : "", state }]}>
          <RouterControls />
          <Routes>
            {["/request", "/pay/:tag"].map((path) => (
              <Route
                key={path}
                path={path}
                element={<RequestLandingScreen node={node} chainIdentity={chainIdentity} />}
              >
                <Route index element={<div>signup</div>} />
              </Route>
            ))}
            <Route path="/contacts/:tag/send" element={<SendProbe />} />
            <Route path="/enter" element={<EnterProbe />} />
          </Routes>
        </MemoryRouter>
      )
      root.render(strict ? <React.StrictMode>{tree}</React.StrictMode> : tree)
    })
  }

  const button = (text: string) =>
    [...container.querySelectorAll("button")].find((b) => b.textContent?.includes(text))!
  const payButton = () =>
    container.querySelector<HTMLButtonElement>("[data-testid=request-pay-with-wallet]")!
  const clickPay = () =>
    act(async () => {
      payButton().dispatchEvent(new MouseEvent("click", { bubbles: true }))
    })

  it("offers a signed-in payer no way back to the send sheet from a refused link", async () => {
    await seedOnboarded({}, "localhost")
    resolve.mockRejectedValue(requesterMismatch("alice", "moved"))
    await render(fragmentFor(), false, { external: true })
    expect(container.textContent).toContain(fmt(copy.problems.requesterMoved, { tag: "alice" }))
    expect(container.querySelector(".ww-invite__content button")).toBeNull()
  })

  it("refuses a packet stamped for another rollup", async () => {
    await render(fragmentFor({ networkId: "0xother" }))

    expect(container.textContent).toContain(copy.problems.wrongNetwork)
    expect(resolve).not.toHaveBeenCalled()
  })

  it("refuses a default node on another chain when L1 gives no answer, as boot does", async () => {
    await seedOnboarded({}, "localhost")
    portal.mockRejectedValue(
      new L1IdentityUnavailableError({ call: "ROLLUP", cause: new TypeError("Failed to fetch") }),
    )
    getNodeInfo.mockResolvedValueOnce({
      ...(await getNodeInfo()),
      l1ChainId: CHAIN_ID + 1,
    })
    await render(fragmentFor())

    expect(container.textContent).not.toContain("send-sheet")
  })

  it("never takes a custom node's word when L1 gives no answer", async () => {
    await seedOnboarded({}, "localhost")
    config.endpoints = {
      ...defaultConfig.endpoints,
      node: { source: "settings", isDefault: false },
    }
    portal.mockRejectedValue(
      new L1IdentityUnavailableError({ call: "ROLLUP", cause: new TypeError("Failed to fetch") }),
    )
    await render(fragmentFor())

    expect(container.textContent).not.toContain("send-sheet")
  })

  it.each(["resolve", "reject"])(
    "ignores a stale %s after an in-flight fragment replacement",
    async (outcome) => {
      let finishOld!: (result: unknown) => void
      let rejectOld!: (error: Error) => void
      resolve.mockImplementationOnce(
        () =>
          new Promise((done, fail) => {
            finishOld = done
            rejectOld = fail
          }),
      )
      resolve.mockResolvedValueOnce({
        sipaAddress: SIPA,
        decimals: 6,
        feeAtomic: 500_000n,
        grossAtomic: 2_500_000n,
        paymentUri: "ethereum:new",
      })
      await render(fragmentFor(), true)
      const nextId = `0x${"0b".repeat(32)}`
      await act(async () =>
        navigate(`/request#${fragmentFor({ requestId: nextId, amountAtomic: 2_000_000n })}`),
      )
      expect(resolve).toHaveBeenCalledTimes(2)
      expect(resolve.mock.calls[1][0].requestId).toBe(nextId)
      expect(payButton().disabled).toBe(false)
      await act(async () => {
        if (outcome === "reject") rejectOld(new Error("stale failure"))
        else
          finishOld({
            sipaAddress: SIPA,
            decimals: 6,
            feeAtomic: 500_000n,
            grossAtomic: 1_500_000n,
            paymentUri: "ethereum:old",
          })
      })
      expect(container.textContent).not.toContain("stale failure")
      await clickPay()
      expect(button("pay-sheet").dataset.uri).toBe("ethereum:new")
      expect(resolve).toHaveBeenCalledTimes(2)
    },
  )

  it("does not reopen a previous packet's payment sheet after the fragment changes", async () => {
    resolve.mockResolvedValue({
      sipaAddress: SIPA,
      decimals: 6,
      feeAtomic: 500_000n,
      grossAtomic: 1_500_000n,
      paymentUri: "ethereum:capture",
    })
    await render(fragmentFor(), true)
    await clickPay()
    expect(container.textContent).toContain("pay-sheet")
    await act(async () =>
      navigate(`/request#${fragmentFor({ requestId: `0x${"0c".repeat(32)}` })}`),
    )
    expect(container.textContent).not.toContain("pay-sheet")
    expect(payButton().disabled).toBe(false)
    expect(resolve).toHaveBeenCalledTimes(2)
  })

  it("leaves an unmounted landing untouched when its resolution settles", async () => {
    let finish!: (result: unknown) => void
    resolve.mockImplementation(
      () =>
        new Promise((done) => {
          finish = done
        }),
    )
    await render(fragmentFor(), true)
    await act(async () => root.render(<div>Left the request</div>))
    await act(async () =>
      finish({
        sipaAddress: SIPA,
        decimals: 6,
        feeAtomic: 500_000n,
        grossAtomic: 1_500_000n,
        paymentUri: "ethereum:capture",
      }),
    )
    expect(container.textContent).toBe("Left the request")
    expect(resolve).toHaveBeenCalledTimes(1)
  })

  it("keeps packet guards ahead of address resolution under StrictMode", async () => {
    await render(fragmentFor({ expiresAt: Date.now() - 1000 }), true)
    expect(container.textContent).toContain(copy.problems.expired)
    expect(resolve).not.toHaveBeenCalled()
  })

  describe("pay page", () => {
    it("refuses a request whose payee is not the page's", async () => {
      await render(fragmentFor(), false, undefined, "/pay/bob")
      expect(container.textContent).toContain("could not be read")
      expect(resolve).not.toHaveBeenCalled()
    })

    it("drops the last payee's quote and sheet when the page moves to another tag", async () => {
      resolve.mockResolvedValueOnce({
        sipaAddress: SIPA,
        decimals: 6,
        feeAtomic: 500_000n,
        grossAtomic: 1_500_000n,
        paymentUri: "ethereum:alice",
      })
      await render("", false, undefined, "/pay/alice")
      await clickPay()
      expect(container.textContent).toContain("pay-sheet")
      resolve.mockReturnValue(new Promise(() => {}))
      await act(async () => navigate("/pay/bob"))
      expect(container.textContent).toContain("Pay @bob")
      expect(container.textContent).not.toContain("pay-sheet")
      expect(payButton().disabled).toBe(true)
    })
  })
})

import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, Route, Routes, useNavigate, type NavigateFunction } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { encodeRequestInline, type RequestInlinePacket } from "@obsidion/front-core"

const SIPA = `0x${"aa".repeat(20)}`
const L1_TOKEN = `0x${"22".repeat(20)}`
const L2_TOKEN = `0x${"1b".repeat(32)}`
const ROLLUP = "0xrollup"
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

const { resolve, identity } = vi.hoisted(() => ({
  resolve: vi.fn(),
  identity: { value: null as object | null },
}))

vi.mock("../src/features/identity/walletIdentity", () => ({
  loadOnboardedIdentity: () => identity.value,
}))
vi.mock("../src/config/env", async () => {
  const { http } = await import("viem")
  const { foundry } = await import("viem/chains")
  return {
    getConfig: () => ({
      network: "sandbox",
      nodeUrl: "http://127.0.0.1:8080",
      l1ChainId: CHAIN_ID,
      l1Chain: foundry,
    }),
    l1Transport: () => http("http://127.0.0.1:8545"),
  }
})
vi.mock("../src/config/oxideTuple", () => ({
  getOxideTuple: async () => ({ token: L1_TOKEN, l2Token: L2_TOKEN }),
  requireTupleField: (tuple: Record<string, unknown>, key: string) => tuple[key],
}))
vi.mock("../src/features/requests/accountlessRequest", () => ({
  resolveAccountlessRequest: resolve,
}))
// The sheet pulls wagmi/RainbowKit; the landing is what these cover.
vi.mock("../src/features/requests/ExternalWalletPayModal", () => ({
  ExternalWalletPayModal: () => <div>pay-sheet</div>,
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
}))

const { RequestLandingScreen } = await import("../src/features/requests/RequestLandingScreen")
/** The node the app hands the screen. */
const node = { getL1ContractAddresses: async () => ({ rollupAddress: ROLLUP }) } as never

declare global {
  // eslint-disable-next-line no-var
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

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    resolve.mockReset()
    identity.value = null
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  async function render(fragment: string, strict = false, state?: object) {
    await act(async () => {
      const tree = (
        <MemoryRouter initialEntries={[{ pathname: "/request", hash: `#${fragment}`, state }]}>
          <RouterControls />
          <Routes>
            <Route path="/request" element={<RequestLandingScreen node={node} />}>
              <Route index element={<div>signup</div>} />
            </Route>
            <Route path="/contacts/:tag/send" element={<div>send-sheet</div>} />
          </Routes>
        </MemoryRouter>
      )
      root.render(strict ? <React.StrictMode>{tree}</React.StrictMode> : tree)
    })
  }

  const button = (text: string) =>
    [...container.querySelectorAll("button")].find((b) => b.textContent?.includes(text))!
  const click = async (text: string) => {
    await act(async () => {
      button(text).dispatchEvent(new MouseEvent("click", { bubbles: true }))
    })
  }

  it("holds the external-wallet row until the address and fee resolve", async () => {
    resolve.mockReturnValue(new Promise(() => {}))
    await render(fragmentFor())

    expect(container.textContent).toContain("Someone requested")
    expect(container.textContent).toContain("$1")
    expect(container.textContent).toContain("Pizza dinner")
    // Signing up never waits on the L1 legs; quoting an onchain payment does.
    expect(button("Pay with zk.money").disabled).toBe(false)
    expect(button("Pay with an Ethereum wallet").disabled).toBe(true)
  })

  it("quotes amount plus fee and opens the pay sheet once resolved", async () => {
    resolve.mockResolvedValue({
      sipaAddress: SIPA,
      feeAtomic: 500_000n,
      grossAtomic: 1_500_000n,
      paymentUri: `ethereum:${L1_TOKEN}@${CHAIN_ID}/transfer?address=${SIPA}&uint256=1500000`,
    })
    await render(fragmentFor())

    expect(button("Pay with an Ethereum wallet").textContent).toContain("Pay $1.50 with fee")
    await click("Pay with an Ethereum wallet")
    expect(container.textContent).toContain("pay-sheet")
  })

  it("reuses one resolve across StrictMode replay and lets the live subscriber finish", async () => {
    let finish!: (result: unknown) => void
    resolve.mockReturnValue(
      new Promise((done) => {
        finish = done
      }),
    )
    await render(fragmentFor(), true)
    expect(resolve).toHaveBeenCalledTimes(1)
    await act(async () =>
      finish({
        sipaAddress: SIPA,
        feeAtomic: 500_000n,
        grossAtomic: 1_500_000n,
        paymentUri: `ethereum:${L1_TOKEN}@${CHAIN_ID}/transfer?address=${SIPA}&uint256=1500000`,
      }),
    )
    expect(button("Pay with an Ethereum wallet").disabled).toBe(false)
    expect(button("Pay with an Ethereum wallet").textContent).toContain("Pay $1.50 with fee")
  })

  it("starts one new operation for retry after failure under StrictMode", async () => {
    resolve.mockRejectedValueOnce(new Error("RPC unavailable"))
    let finish!: (result: unknown) => void
    resolve.mockImplementationOnce(
      () =>
        new Promise((done) => {
          finish = done
        }),
    )
    await render(fragmentFor(), true)
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain("RPC unavailable")
    await click("Try again")
    expect(resolve).toHaveBeenCalledTimes(2)
    expect(button("Pay with an Ethereum wallet").disabled).toBe(true)
    await act(async () =>
      finish({
        sipaAddress: SIPA,
        feeAtomic: 500_000n,
        grossAtomic: 1_500_000n,
        paymentUri: "ethereum:capture",
      }),
    )
    expect(button("Pay with an Ethereum wallet").disabled).toBe(false)
    expect(resolve).toHaveBeenCalledTimes(2)
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
      expect(button("Pay with an Ethereum wallet").textContent).toContain("Pay $2.50 with fee")
      await act(async () => {
        if (outcome === "reject") rejectOld(new Error("stale failure"))
        else
          finishOld({
            sipaAddress: SIPA,
            feeAtomic: 500_000n,
            grossAtomic: 1_500_000n,
            paymentUri: "ethereum:old",
          })
      })
      expect(container.textContent).not.toContain("stale failure")
      expect(button("Pay with an Ethereum wallet").textContent).toContain("Pay $2.50 with fee")
      expect(resolve).toHaveBeenCalledTimes(2)
    },
  )

  it("does not reopen a previous packet's payment sheet after the fragment changes", async () => {
    resolve.mockResolvedValue({
      sipaAddress: SIPA,
      feeAtomic: 500_000n,
      grossAtomic: 1_500_000n,
      paymentUri: "ethereum:capture",
    })
    await render(fragmentFor(), true)
    await click("Pay with an Ethereum wallet")
    expect(container.textContent).toContain("pay-sheet")
    await act(async () =>
      navigate(`/request#${fragmentFor({ requestId: `0x${"0c".repeat(32)}` })}`),
    )
    expect(container.textContent).not.toContain("pay-sheet")
    expect(button("Pay with an Ethereum wallet").disabled).toBe(false)
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
    expect(container.textContent).toContain("This payment request has expired")
    expect(resolve).not.toHaveBeenCalled()
  })

  it("hands the fragment to the signup outlet, to be replayed once there is an identity", async () => {
    resolve.mockReturnValue(new Promise(() => {}))
    await render(fragmentFor())

    await click("Pay with zk.money")
    // Log in leads; the signup outlet is one more choice away.
    expect(button("Log in")).toBeDefined()
    expect(container.textContent).not.toContain("Choose a method to pay")
    await click("Create account")
    expect(container.textContent).toContain("signup")
  })

  it("offers a signed-in payer the send sheet back instead of a log-in prompt", async () => {
    identity.value = {}
    resolve.mockReturnValue(new Promise(() => {}))
    await render(fragmentFor(), false, { external: true })

    expect(container.textContent).toContain("Pay with an Ethereum wallet")
    expect(container.textContent).not.toContain("Log in")
    expect(container.textContent).not.toContain("No fee and your balance stays private")

    await click("Pay with zk.money instead")
    expect(container.textContent).toContain("send-sheet")
  })
})

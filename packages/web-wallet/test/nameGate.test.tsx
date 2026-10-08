import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resetDemoFlagForTests } from "../src/dev/demoFlag"

const loadWalletIdentity = vi.fn()
vi.mock("../src/features/identity/walletIdentity", () => ({ loadWalletIdentity }))
const useSponsoredRailPending = vi.fn()
vi.mock("../src/features/onboarding/sponsoredRailReadiness", () => ({ useSponsoredRailPending }))
const claimSponsorContext = vi.fn()
vi.mock("../src/features/onboarding/claimSponsorship", () => ({ claimSponsorContext }))
let wallet: { node: object } | null
let account: object | null
let contractService: object | null
vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  useAztecContext: () => ({ obsidionWallet: wallet }),
  useAccountContext: () => ({ obsidionAccount: account }),
  useContractServiceContext: () => ({ contractService }),
}))

const registrationRail = await vi.importActual<
  typeof import("../src/features/onboarding/registrationRail")
>("../src/features/onboarding/registrationRail")
const sponsoredRailReadiness = await vi.importActual<
  typeof import("../src/features/onboarding/sponsoredRailReadiness")
>("../src/features/onboarding/sponsoredRailReadiness")

const { NameGate, SponsoredRailGate } = await import("../src/App")

/**
 * Two gates front the wallet's flows. NameGate sends a nameless account to register one. Behind
 * it, SponsoredRailGate holds the flows whose only rail is ClaimFPC-sponsored: the open rail admits
 * an account the L1 registry registered, and the registry's proof is a name plus the L1->L2 message
 * it emits, which a just-registered account gets a few L1 blocks later. Each stops the attempt
 * with the reason rather than at the fee. Deposit sits behind the first gate only: its address
 * derives from the account, and the broadcast behind it waits for the rail in the background.
 */
describe("gates on the wallet's flows", () => {
  let host: HTMLDivElement
  let root: Root

  beforeEach(() => {
    wallet = { node: {} }
    account = {}
    contractService = {}
    window.history.replaceState({}, "", "/")
    sessionStorage.removeItem("webwallet.demo")
    resetDemoFlagForTests()
    loadWalletIdentity.mockReset()
    claimSponsorContext.mockReset()
    useSponsoredRailPending.mockReset()
    useSponsoredRailPending.mockReturnValue(false)
    host = document.createElement("div")
    document.body.appendChild(host)
    root = createRoot(host)
  })
  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    vi.useRealTimers()
    window.history.replaceState({}, "", "/")
    sessionStorage.removeItem("webwallet.demo")
    resetDemoFlagForTests()
  })

  const mount = (path = "send", Gate: typeof NameGate = SponsoredRailGate) =>
    act(() => {
      root.render(
        <MemoryRouter initialEntries={[`/${path}`]}>
          <Routes>
            <Route element={<Gate />}>
              <Route path={path} element={<div>{path} screen</div>} />
            </Route>
          </Routes>
        </MemoryRouter>,
      )
    })

  describe("name gate", () => {
    it("blocks the attempt, and says why, when the account has no name", () => {
      loadWalletIdentity.mockReturnValue({ address: "0xabc" })
      mount("deposit", NameGate)
      expect(host.querySelector('[data-testid="name-required"]')).toBeTruthy()
      expect(host.textContent).toContain("Register a name first")
      expect(host.textContent).not.toContain("deposit screen")
    })

    it("lets a named account through", () => {
      loadWalletIdentity.mockReturnValue({ address: "0xabc", handle: "taga" })
      mount("deposit", NameGate)
      expect(host.textContent).toContain("deposit screen")
      expect(host.querySelector('[data-testid="name-required"]')).toBeNull()
    })

    it("does not block before an identity exists — WalletGate owns that case", () => {
      loadWalletIdentity.mockReturnValue(null)
      mount("deposit", NameGate)
      expect(host.textContent).toContain("deposit screen")
    })

    it("opens the deposit screen while the registration message is still in flight", () => {
      // The address needs no rail; its broadcast waits in the background.
      loadWalletIdentity.mockReturnValue({ address: "0xabc", handle: "taga" })
      useSponsoredRailPending.mockReturnValue(true)
      mount("deposit", NameGate)
      expect(host.textContent).toContain("deposit screen")
      expect(host.querySelector('[data-testid="registration-pending"]')).toBeNull()
    })
  })

  describe("sponsored rail gate", () => {
    it("holds a named account while its registration message is still in flight", () => {
      loadWalletIdentity.mockReturnValue({ address: "0xabc", handle: "taga" })
      useSponsoredRailPending.mockReturnValue(true)
      mount()
      expect(host.querySelector('[data-testid="registration-pending"]')).toBeTruthy()
      expect(host.textContent).toContain("Finishing your registration")
      expect(host.textContent).not.toContain("send screen")
    })

    it("shows a generic loading screen while the registration check has not answered", () => {
      loadWalletIdentity.mockReturnValue({ address: "0xabc", handle: "taga" })
      useSponsoredRailPending.mockReturnValue(undefined)
      mount()
      expect(host.textContent).toContain("Loading zk.money")
      expect(host.textContent).not.toContain("Finishing your registration")
      expect(host.textContent).not.toContain("send screen")
    })

    it("opens the flow once the message lands", () => {
      loadWalletIdentity.mockReturnValue({ address: "0xabc", handle: "taga" })
      useSponsoredRailPending.mockReturnValue(false)
      mount()
      expect(host.textContent).toContain("send screen")
      expect(host.querySelector('[data-testid="registration-pending"]')).toBeNull()
    })

    it("never mounts a sponsored flow while checking registration or waiting for its sweep", async () => {
      vi.useFakeTimers()
      loadWalletIdentity.mockReturnValue({ address: "0xabc", handle: "taga" })
      useSponsoredRailPending.mockImplementation(sponsoredRailReadiness.useSponsoredRailPending)
      let rejectCheck!: (reason: unknown) => void
      claimSponsorContext.mockReturnValueOnce(
        new Promise((_, reject) => {
          rejectCheck = reject
        }),
      )
      const withdrawMounted = vi.fn()
      function WithdrawIntroduction() {
        withdrawMounted()
        return <div>Withdraw to L1</div>
      }
      act(() => {
        root.render(
          <MemoryRouter initialEntries={["/withdraw"]}>
            <Routes>
              <Route element={<SponsoredRailGate />}>
                <Route path="withdraw" element={<WithdrawIntroduction />} />
              </Route>
            </Routes>
          </MemoryRouter>,
        )
      })
      expect(withdrawMounted).not.toHaveBeenCalled()
      expect(host.textContent).toContain("Loading zk.money")
      expect(host.textContent).not.toContain("Finishing your registration")

      await act(async () => {
        rejectCheck(new registrationRail.RegistrationPendingError({ pending: "message" }))
      })
      expect(withdrawMounted).not.toHaveBeenCalled()
      expect(host.textContent).toContain("Finishing your registration")

      claimSponsorContext.mockResolvedValueOnce({})
      await act(async () => {
        await vi.advanceTimersByTimeAsync(12_000)
      })
      expect(withdrawMounted).toHaveBeenCalled()
      expect(host.textContent).toContain("Withdraw to L1")
    })

    it("opens a registered account's flow after the initial check succeeds", async () => {
      loadWalletIdentity.mockReturnValue({ address: "0xabc", handle: "taga" })
      useSponsoredRailPending.mockImplementation(sponsoredRailReadiness.useSponsoredRailPending)
      let resolveCheck!: (value: unknown) => void
      claimSponsorContext.mockReturnValueOnce(
        new Promise((resolve) => {
          resolveCheck = resolve
        }),
      )
      mount()
      expect(host.textContent).not.toContain("send screen")
      await act(async () => {
        resolveCheck({})
      })
      expect(host.textContent).toContain("send screen")
    })

    it.each(["send", "withdraw"])("opens the demo %s route without wallet services", (path) => {
      window.history.replaceState({}, "", "/?demo=activity")
      wallet = account = contractService = null
      loadWalletIdentity.mockReturnValue({ address: "0xabc", handle: "demo" })
      useSponsoredRailPending.mockImplementation(sponsoredRailReadiness.useSponsoredRailPending)
      mount(path)
      expect(host.textContent).toContain(`${path} screen`)
      expect(host.querySelector('[data-testid="registration-pending"]')).toBeNull()
      expect(claimSponsorContext).not.toHaveBeenCalled()
    })

    it("holds a real wallet's sponsored route behind the loading screen until wallet services are available", () => {
      wallet = account = contractService = null
      loadWalletIdentity.mockReturnValue({ address: "0xabc", handle: "taga" })
      useSponsoredRailPending.mockImplementation(sponsoredRailReadiness.useSponsoredRailPending)
      mount("withdraw")
      expect(host.textContent).toContain("Loading zk.money")
      expect(host.textContent).not.toContain("Finishing your registration")
      expect(host.textContent).not.toContain("withdraw screen")
      expect(claimSponsorContext).not.toHaveBeenCalled()
    })
  })
})

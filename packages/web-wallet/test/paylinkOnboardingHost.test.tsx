/**
 * What the paylink host hands the wizard: the asset layer's paylink services, read by the real
 * `usePaylinkKit`, so a ticket-funded signup can claim its link. The wizard is a probe here; what
 * it does with the services is the pending-step suite's subject.
 */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { AssetProvider } from "@obsidion/front-core"

const h = vi.hoisted(() => ({
  asset: {} as Record<string, unknown>,
}))

vi.mock("../../front-core/dist/hooks/useAsset", () => ({ useAsset: () => h.asset }))
vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  useAztecContext: () => ({ obsidionWallet: { wallet: true }, rollupAddress: "0xrollup" }),
  useContractServiceContext: () => ({ contractService: { service: true } }),
}))
vi.mock("../src/features/onboarding/OnboardingScreen", () => ({
  OnboardingScreen: ({
    paylinkKit,
    ticketSignup,
  }: {
    paylinkKit?: unknown
    ticketSignup?: boolean
  }) => (
    <div data-testid="wizard" data-ticket={String(Boolean(ticketSignup))}>
      {paylinkKit ? JSON.stringify(paylinkKit) : "no kit"}
    </div>
  ),
}))

const { PaylinkOnboardingScreen } = await import("../src/features/paylink/PaylinkOnboardingScreen")

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  h.asset = {}
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

const render = () =>
  act(async () => {
    root.render(
      <AssetProvider>
        <PaylinkOnboardingScreen embedded ticketSignup />
      </AssetProvider>,
    )
  })

const wizard = () => container.querySelector('[data-testid="wizard"]')

describe("PaylinkOnboardingScreen", () => {
  it("hands the wizard the layer's services once the token service and the enclave are live", async () => {
    h.asset = { tokenService: { token: true }, teeSigner: { tee: true } }
    await render()
    expect(wizard()?.getAttribute("data-ticket")).toBe("true")
    expect(JSON.parse(wizard()!.textContent!)).toEqual({
      wallet: { wallet: true },
      tokenService: { token: true },
      contractService: { service: true },
      teeSigner: { tee: true },
      rollupAddress: "0xrollup",
    })
  })

  it("hands nothing while the layer is still connecting", async () => {
    h.asset = { tokenService: { token: true } }
    await render()
    expect(wizard()?.textContent).toBe("no kit")
  })
})

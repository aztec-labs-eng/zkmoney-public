/**
 * The withdrawal exit sheet's confirm copy. The three claims it makes are the ones a user acts on,
 * and each is a property of the portal route rather than of the wording: the submitter pays gas,
 * the burn's relayer tip settles to the submitting wallet, and a relayer that wins the race makes
 * the portal revert this transaction without moving anything.
 */
import React, { act } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createRoot, type Root } from "react-dom/client"
import type { Hex } from "viem"
import type { WithdrawalRecord } from "@obsidion/front-core"

const h = vi.hoisted(() => ({ selfFinalize: vi.fn() }))

vi.mock("../src/config/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config/env")>()),
  getConfig: () => ({ l1ChainId: 11155111 }),
}))
vi.mock("../src/features/withdraw/selfFinalize", () => ({ selfFinalize: h.selfFinalize }))
vi.mock("../src/lib/analytics", () => ({
  fireEvent: vi.fn(),
  failureCode: () => "x",
  lapTimer: () => () => 0,
}))
vi.mock("../src/errors/errorModal", () => ({ showReportableError: vi.fn() }))
vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  useAztecContext: () => ({ obsidionWallet: { node: {} } }),
  useAssetContext: () => ({ teeSigner: {} }),
}))
// The DS drags in liquid-glass optics jsdom can't render; this test is about the sheet's content.
vi.mock("@obsidion/web-ds", () => ({
  ConfirmationSheetDetailRow: ({ label, value }: { label: string; value: React.ReactNode }) => (
    <div>
      {label}
      <span>{value}</span>
    </div>
  ),
  DoubleCheckIcon: () => null,
  PrimaryGradientButton: ({ title, onClick }: { title: string; onClick?: () => void }) => (
    <button onClick={onClick}>{title}</button>
  ),
  Spinner: () => null,
  TopNavIconButton: () => null,
}))

const { WithdrawalExitModal } = await import("../src/features/withdraw/WithdrawalExitModal")

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

const L1_TX = `0x${"ab".repeat(32)}` as Hex

const record = {
  localId: "wdraw_1",
  recipient: `0x${"dd".repeat(20)}`,
  recipientProvenance: "saved-recipient",
  amount: "210",
  tokenSymbol: "DAI",
  phase: "finalizing_l1",
  startTime: Date.now() - 60_000,
  l2TxHash: `0x${"0a".repeat(32)}`,
} as WithdrawalRecord

describe("WithdrawalExitModal", () => {
  let container: HTMLDivElement
  let root: Root

  const button = (title: string) =>
    Array.from(container.querySelectorAll("button")).find((b) => b.textContent === title)

  beforeEach(async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    h.selfFinalize.mockResolvedValue(L1_TX)
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root.render(<WithdrawalExitModal record={record} onClose={vi.fn()} />)
    })
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.clearAllMocks()
  })

  it("promises only what the portal route delivers: gas out, the reserved fee back, no redirect", () => {
    const text = container.textContent!
    expect(text).toContain("You pay the gas")
    expect(text).toMatch(/comes back to your wallet/)
    expect(text).toMatch(/nobody can redirect them/)
  })

  it("says a lost race fails without moving anything and the withdrawal still finishes", () => {
    const text = container.textContent!
    expect(text).toMatch(/fails without moving anything/)
    expect(text).toMatch(/withdrawal still finishes/)
    expect(text).not.toMatch(/completes without doing anything/)
  })

  it("shows the two facts the burn already fixed, and finalizes from the button", async () => {
    expect(container.textContent).toContain("210 DAI")
    expect(container.textContent).toContain("Sepolia")
    await act(async () => button("Finalize this withdrawal")!.click())
    expect(h.selfFinalize).toHaveBeenCalledOnce()
    expect(container.textContent).toContain("Withdrawal released")
  })

  // A swap burn paid a counterfactual escrow, so this transaction releases DAI there and the
  // recipient is paid in their chosen asset only after a relayer runs the swap. The direct copy
  // claimed the funds reached the named recipient, which is false in both amount and asset — and
  // most misleading exactly here, where the user is self-finalizing because no relayer ran.
  describe("a swap withdrawal", () => {
    const swapRecord = {
      ...record,
      swapOutput: "USDC",
      swapEscrow: `0x${"ee".repeat(20)}`,
    } as WithdrawalRecord

    beforeEach(async () => {
      await act(async () => {
        root.render(<WithdrawalExitModal record={swapRecord} onClose={vi.fn()} />)
      })
    })

    it("names the escrow as the release target, not the recipient", () => {
      const text = container.textContent!
      expect(text).toContain("Released to")
      expect(text).toMatch(/releases the DAI to the swap escrow/)
      expect(text).not.toMatch(/funds go to the address the withdrawal already named/)
    })

    it("says the recipient is paid by the later swap, not by this transaction", () => {
      expect(container.textContent).toMatch(/swap into your chosen asset is a separate step/)
    })

    it("does not claim the recipient received the funds on success", async () => {
      await act(async () => button("Finalize this withdrawal")!.click())
      const text = container.textContent!
      expect(text).toContain("released to the swap escrow")
      expect(text).toMatch(/paid in USDC once a relayer runs the swap/)
      expect(text).not.toMatch(/210 DAI released to 0x/)
    })
  })
})

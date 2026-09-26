/**
 * The status a detail sheet's hero badge shows, against the badge the feed row shows for the same
 * record. A creator paylink row's hero is the link's own lifecycle, so an expired link that is still
 * awaiting its reclaim never reads as finished; a plain transaction's hero is the transaction's own
 * state. The agreement is pinned against the shared label maps, not against the words themselves.
 */
import React, { act } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createRoot, type Root } from "react-dom/client"
import type { Hex } from "viem"
import {
  PAYLINK_STATUS_LABEL,
  globalEventEmitter,
  type PaylinkStatusKind,
  type PaylinkTransaction,
  type TransactionStatus,
  type WithdrawalRecord,
} from "@obsidion/front-core"
import { activityStatusLabel, type ActivityRowView } from "../src/ui/screens/activityView"

const h = vi.hoisted(() => ({ recheckPaylinkClaim: vi.fn(), usePaylinkDeps: vi.fn() }))

vi.mock("../src/config/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config/env")>()),
  getConfig: () => ({ l1ChainId: 11155111, network: "testnet", nodeUrl: "http://node.invalid" }),
}))
vi.mock("../src/lib/explorer", () => ({
  l1TxUrl: () => null,
  l1AddressUrl: () => null,
  l2TxUrl: () => undefined,
}))
vi.mock("../src/lib/analytics", () => ({ fireEvent: vi.fn(), failureCode: () => "unknown" }))
vi.mock("../src/features/paylink/sponsoredPaylink", () => ({ recoverSponsoredLink: vi.fn() }))
vi.mock("../src/features/notifications/PaylinkClaimMount", () => ({
  recheckPaylinkClaim: h.recheckPaylinkClaim,
}))
vi.mock("../src/features/paylink/usePaylinkDeps", () => ({ usePaylinkDeps: h.usePaylinkDeps }))
vi.mock("react-router-dom", () => ({
  useNavigate: () => vi.fn(),
  useLocation: () => ({ pathname: "/" }),
}))
// The DS drags in liquid-glass optics jsdom can't render; these tests are about the badge's wording.
vi.mock("@obsidion/web-ds", () => ({
  Card: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  ConfirmationSheetDetailRow: ({ label, value }: { label: string; value: React.ReactNode }) => (
    <div data-testid="row">
      <span data-testid="label">{label}</span>
      <span data-testid="value">{value}</span>
    </div>
  ),
  CopyableLinkRow: () => null,
  GradientInitialAvatar: () => null,
  GradientText: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
  avatarColors: () => ["#000", "#fff"],
  Icon: () => null,
  IconCircle: () => null,
  PrimaryGradientButton: ({ title }: { title: string }) => <button>{title}</button>,
  Spinner: () => null,
  StatusBadge: ({ label }: { label: string }) => <span data-testid="hero-badge">{label}</span>,
  TopNavIconButton: () => null,
}))

const { TxDetailModal } = await import("../src/ui/screens/TxDetailModal")
const { WithdrawalDetailModal } = await import("../src/ui/screens/WithdrawalDetailModal")
const { WITHDRAWAL_PHASE_LABEL } = await import("../src/ui/screens/useActivityEntries")

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

const CREATED_MS = Date.UTC(2026, 4, 1, 12, 0)

const creatorRow = (
  paylinkStatus: PaylinkStatusKind,
  status: TransactionStatus = "success",
): ActivityRowView => ({
  id: "row_1",
  counterparty: "Sent via paylink",
  timestamp: "1 May, 12:00",
  timestampMs: CREATED_MS,
  amount: "-$30.00",
  status,
  statusLabel: activityStatusLabel(status, paylinkStatus),
  txHash: `0x${"66".repeat(32)}`,
  // No decodable fragment would strand the sheet's share block, which the hero renders above.
  paylink: "https://zk.money/link#frag",
  paylinkStatus,
  paylinkRow: {
    action: "Pay To Email",
    flavor: "direct",
    status,
    timestamp: CREATED_MS,
    obsidionAccountAddress: `0x${"3f".repeat(32)}`,
    fromClaimable: 0,
    untilClaimable: Math.floor(CREATED_MS / 1000) + 86_400,
    token: { symbol: "DAI", amount: 30 },
  } as unknown as PaylinkTransaction,
})

const plainRow = (status: TransactionStatus): ActivityRowView => ({
  id: "row_2",
  counterparty: "Ada",
  timestamp: "1 May, 12:00",
  timestampMs: CREATED_MS,
  amount: "-$5.00",
  status,
  statusLabel: activityStatusLabel(status, undefined),
  txHash: `0x${"77".repeat(32)}`,
})

const withdrawal = (phase: WithdrawalRecord["phase"]): WithdrawalRecord =>
  ({
    localId: "wdraw_1",
    recipient: `0x${"dd".repeat(20)}`,
    recipientProvenance: "saved-recipient",
    amount: "120",
    tokenSymbol: "DAI",
    phase,
    startTime: CREATED_MS,
    l2TxHash: `0x${"0a".repeat(32)}` as Hex,
  } as WithdrawalRecord)

describe("detail sheet hero badge", () => {
  let container: HTMLDivElement
  let root: Root

  const hero = () => container.querySelector("[data-testid='hero-badge']")?.textContent
  const labels = () =>
    Array.from(container.querySelectorAll("[data-testid='label']")).map((el) => el.textContent)

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    h.usePaylinkDeps.mockReturnValue(undefined)
    // A recheck that finds nothing leaves the hero on the row's stored status.
    h.recheckPaylinkClaim.mockResolvedValue(undefined)
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.clearAllMocks()
  })

  const showTx = (row: ActivityRowView) =>
    act(async () => {
      root.render(<TxDetailModal row={row} onClose={vi.fn()} />)
    })

  it.each(["expired", "awaitingClaim", "claimed", "refunded", "migrated"] as const)(
    "heroes a creator link's %s state in the word its feed row uses",
    async (kind) => {
      const row = creatorRow(kind)
      await showTx(row)

      expect(hero()).toBe(PAYLINK_STATUS_LABEL[kind])
      expect(hero()).toBe(row.statusLabel)
    },
  )

  it("never calls an expired link finished — it is still awaiting its reclaim", async () => {
    await showTx(creatorRow("expired"))

    expect(hero()).toBe(PAYLINK_STATUS_LABEL.expired)
    expect(hero()).not.toBe("Completed")
  })

  it("speaks for the transaction first, while the link's own state is not yet settled", async () => {
    for (const status of ["pending", "failed"] as const) {
      const row = creatorRow("awaitingClaim", status)
      await showTx(row)
      expect(hero(), status).toBe(row.statusLabel)
    }
  })

  it("takes the claimed status once the shared reconciler's recheck flips the row", async () => {
    const row = creatorRow("awaitingClaim")
    h.recheckPaylinkClaim.mockImplementation(async (txHash: string) => {
      globalEventEmitter.emitPaylinkClaimed({ txHash })
    })

    await showTx(row)

    expect(h.recheckPaylinkClaim).toHaveBeenCalledWith(row.txHash)
    expect(hero()).toBe(PAYLINK_STATUS_LABEL.claimed)
  })

  it("ignores another row's claim", async () => {
    h.recheckPaylinkClaim.mockImplementation(async () => {
      globalEventEmitter.emitPaylinkClaimed({ txHash: `0x${"99".repeat(32)}` })
    })

    await showTx(creatorRow("awaitingClaim"))

    expect(hero()).toBe(PAYLINK_STATUS_LABEL.awaitingClaim)
  })

  it("carries the link's state in the hero alone, with no row restating it", async () => {
    await showTx(creatorRow("awaitingClaim"))

    expect(labels()).not.toContain("Link status")
  })

  it.each(["pending", "failed", "success"] as const)(
    "heroes a plain %s transaction in its own state",
    async (status) => {
      const row = plainRow(status)
      await showTx(row)

      // A plain pending send says what it is doing; settled rows keep the feed row's word.
      expect(hero()).toBe(status === "pending" ? "Sending" : row.statusLabel ?? "Completed")
    },
  )

  it.each([
    "submitting",
    "l2_mined",
    "awaiting_proven",
    "finalizing_l1",
    "failed",
    "done",
  ] as const)("names the leg a %s withdrawal is on in its Status row", async (phase) => {
    await act(async () => {
      root.render(
        <WithdrawalDetailModal record={withdrawal(phase)} amount="-120 DAI" onClose={vi.fn()} />,
      )
    })

    const status = Array.from(container.querySelectorAll(".ww-sheet__fact"))
      .find((row) => row.querySelector("span")?.textContent === "Status")
      ?.querySelector("b")
      ?.textContent?.trim()
    // The sheet is finer-grained than the feed row: a released withdrawal reads Paid, a failed one
    // Failed, and every in-flight leg names what it waits on.
    expect(status).toBe(
      {
        submitting: "Waiting for Aztec confirmation",
        l2_mined: "Releasing to Ethereum",
        awaiting_proven: "Releasing to Ethereum",
        finalizing_l1: "Releasing to Ethereum",
        done: "Paid",
        failed: WITHDRAWAL_PHASE_LABEL.failed,
      }[phase],
    )
  })

  it("names the user's own finalization once its tx is in flight", async () => {
    await act(async () => {
      root.render(
        <WithdrawalDetailModal
          record={{ ...withdrawal("finalizing_l1"), finalizeTxHash: `0x${"0b".repeat(32)}` }}
          amount="-120 DAI"
          onClose={vi.fn()}
        />,
      )
    })
    const status = Array.from(container.querySelectorAll(".ww-sheet__fact"))
      .find((row) => row.querySelector("span")?.textContent === "Status")
      ?.querySelector("b")
      ?.textContent?.trim()
    expect(status).toBe("Waiting for your finalization")
  })
})

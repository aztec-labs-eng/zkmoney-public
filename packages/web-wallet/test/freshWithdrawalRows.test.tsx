/**
 * A fresh-address withdrawal is two burns sharing a group id: one feed row, one detail sheet, and
 * an offer to send the funds again once the gas leg is on chain without a mined funds leg. A bell
 * alert opens the same sheets, and its failure text shows only while the withdrawal is failed.
 */
import { act, type ComponentProps } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Hex } from "viem"
import type {
  AppNotificationEntry,
  WithdrawalGroupLeg,
  WithdrawalPhase,
  WithdrawalRecord,
} from "@obsidion/front-core"

vi.mock("../src/config/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config/env")>()),
  getConfig: () => ({ l1ChainId: 11155111, network: "testnet", nodeUrl: "http://node.invalid" }),
}))
vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  useAztecContext: () => ({}),
  useAssetContext: () => ({}),
  useContactsDirectory: () => ({ contacts: [] }),
  useSyncCatchingUp: () => false,
  RequestStorage: { get: () => ({ list: async () => [], subscribe: () => () => {} }) },
}))
vi.mock("@obsidion/web-ds", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/web-ds")>()),
  ActivityListRow: (p: ComponentProps<typeof import("@obsidion/web-ds").ActivityListRow>) => (
    <div data-testid="row">
      <p data-testid="row-text" data-time={p.timestamp} onClick={p.onClick}>
        {[p.counterparty, p.counterpartyBadge, p.amount, p.statusLabel].filter(Boolean).join(" | ")}
      </p>
      {p.actions?.map((a) => (
        <button key={a.title} title={a.title} data-testid="row-action" onClick={a.onClick}>
          {a.title}
        </button>
      ))}
    </div>
  ),
  // The glass buttons need optics jsdom cannot render; these tests are about what they say.
  PrimaryGradientButton: ({ title, onClick }: { title: string; onClick?: () => void }) => (
    <button onClick={onClick}>{title}</button>
  ),
  TopNavIconButton: () => null,
}))
const freshModal = vi.hoisted(() => vi.fn((_props: { resume?: object }) => null))
vi.mock("../src/features/withdraw/WithdrawFreshModal", () => ({ WithdrawFreshModal: freshModal }))
vi.mock("../src/features/paylink/usePaylinkDeps", () => ({ usePaylinkDeps: () => undefined }))
vi.mock("../src/features/paylink/chainTime", () => ({ usePolledChainSeconds: () => undefined }))
vi.mock("../src/features/onboarding/useRegistrationDepositEntry", () => ({
  registrationTagForSipa: () => undefined,
  registrationTagForDeposit: () => undefined,
  useRegistrationDepositEntry: () => null,
}))
vi.mock("../src/features/withdraw/withdrawFunnel", () => ({ reportWithdrawFunnel: () => {} }))

const { useActivityEntries } = await import("../src/ui/screens/useActivityEntries")
const { notificationRoute } = await import("../src/ui/NotificationsPanel")
const { getWithdrawalStore } = await import("../src/features/withdraw/withdrawGateway")

const RECIPIENT = `0x${"aa".repeat(20)}` as const
const GROUP = `0x${"c1".repeat(16)}` as Hex
const BURN = `0x${"b0".repeat(32)}` as const
const withdrawals = getWithdrawalStore()
/** A leg as a withdrawal of its own. */
const plain = { groupId: undefined, groupLeg: undefined, swapOutput: undefined }

/** One burn of the group: 5.35 of gas or 100.5 of funds, so the pair sums to 105.85. */
function leg(
  which: WithdrawalGroupLeg,
  phase: WithdrawalPhase,
  patch: Partial<WithdrawalRecord> = {},
): WithdrawalRecord {
  return {
    localId: `w_${which}`,
    recipient: RECIPIENT,
    recipientProvenance: "saved-recipient",
    recipientAlias: "Ghost",
    amount: which === "gas" ? "5.35" : "100.5",
    tokenSymbol: "DAI",
    swapOutput: which === "gas" ? "ETH" : "USDC",
    phase,
    startTime: which === "gas" ? 1_000 : 2_000,
    // A post-mine leg is delayed by its phase clock; fresh unless a test backdates it.
    phaseEnteredAt: Date.now(),
    l2TxHash: phase === "submitting" ? undefined : which === "gas" ? BURN : `0x${"b1".repeat(32)}`,
    groupId: GROUP,
    groupLeg: which,
    ...patch,
  }
}

/** A swap leg whose escrow args rebuild, so its recovery can be offered. */
const escrowed: Partial<WithdrawalRecord> = {
  swapEscrow: `0x${"e5".repeat(20)}`,
  swapEscrowFactory: `0x${"fa".repeat(20)}`,
  swapNonce: `0x${"01".repeat(32)}`,
  swapRecoveryCommitment: `0x${"02".repeat(32)}`,
  swapRelayerTip: (10n ** 16n).toString(),
}
/** A recorded quote: a leg that swapped says what arrives, a failed one does not. */
const quoted = { relayerTip: "0", fpcFundingCut: "0", swapEstimatedOut: "5", swapOutputDecimals: 1 }
/** A leg that failed before its burn was sent. */
const unsent = { l2TxHash: undefined }

function Feed() {
  const { entries, detailModals } = useActivityEntries()
  return (
    <>
      {entries.map((e) => (
        <div key={e.id} data-testid="entry" data-pending={String(e.pending)}>
          {e.node}
        </div>
      ))}
      {detailModals}
    </>
  )
}

let container: HTMLDivElement
let root: Root
/** The router state the feed mounts with: what a bell entry's tap carries. */
let opened: object | undefined

beforeEach(() => withdrawals.clearAll())
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  opened = undefined
})

const texts = (sel: string) => [...container.querySelectorAll(sel)].map((e) => e.textContent ?? "")
const attrs = (sel: string, name: string) =>
  [...container.querySelectorAll(sel)].map((e) => e.getAttribute(name))
const click = (sel: string) => act(() => container.querySelector<HTMLElement>(sel)!.click())
/** The store upserts by localId, so this moves a leg on or adds the second one. */
const upsert = (record: WithdrawalRecord) => act(() => withdrawals.create(record))

async function render(...legs: WithdrawalRecord[]): Promise<string[]> {
  for (const record of legs) await withdrawals.create(record)
  container = document.body.appendChild(document.createElement("div"))
  root = createRoot(container)
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[{ pathname: "/", state: opened }]}>
        <Feed />
      </MemoryRouter>,
    )
  })
  await act(() => new Promise<void>((r) => setTimeout(r, 0)))
  return texts("[data-testid=row-text]")
}

describe("fresh withdrawal rows", () => {
  const paidGas = leg("gas", "done", { endTime: 3_000 })

  it.each<[string, WithdrawalRecord[], string, boolean, string[]]>([
    ["the worst status", [paidGas, leg("funds", "swapping")], "-$105.85 | Swapping", true, []],
    [
      "a leg's exit",
      [paidGas, leg("funds", "recoverable", escrowed)],
      "-$105.85 | Needs recovery",
      true,
      ["Recover"],
    ],
    ["a paid pair", [paidGas, leg("funds", "done", { endTime: 4_000 })], "-$105.85", false, []],
    ["a lone submitting leg", [leg("gas", "submitting")], "-$5.35 | Pending", true, []],
    [
      "a paid gas leg with no funds leg",
      [paidGas],
      "-$5.35 | Funds not sent",
      true,
      ["Send remaining funds"],
    ],
    [
      "a dropped funds burn, not sent again while it may still land",
      [paidGas, leg("funds", "failed", { droppedBurn: true })],
      "-$105.85 | Failed",
      false,
      [],
    ],
  ])("shows a group as one row: %s", async (_rule, legs, figure, pending, actions) => {
    expect(await render(...legs)).toEqual([`Ghost | Fresh address | ${figure}`])
    expect(attrs("[data-testid=entry]", "data-pending")).toEqual([String(pending)])
    expect(texts("[data-testid=row-action]")).toEqual(actions)
  })

  it("offers the funds leg once the gas leg is mined, and again after the funds leg fails", async () => {
    await render(leg("gas", "l2_mined", { phaseEnteredAt: 0 }))
    // A delayed leg's re-check comes first, and the subline says so.
    expect(texts("[data-testid=row-action]")).toEqual(["Check again", "Send remaining funds"])
    expect(attrs("[data-testid=row-text]", "data-time")).toEqual(["Taking longer than usual"])
    await upsert(leg("funds", "failed", { error: "Proving failed", ...unsent }))
    expect(texts("[data-testid=row-text]")).toEqual(["Ghost | Fresh address | -$105.85 | Failed"])
    await click("[title='Send remaining funds']")
    const sheet = freshModal.mock.lastCall![0]
    expect(sheet).toMatchObject({ recipient: RECIPIENT, walletName: "Ghost" })
    expect(sheet.resume).toEqual({ groupId: GROUP, fundsAsset: "USDC" })
  })

  it("sends a failed DAI funds leg again as DAI, and names no asset without a funds record", async () => {
    await render(leg("gas", "l2_mined"))
    await click("[title='Send remaining funds']")
    expect(freshModal.mock.lastCall![0].resume).toEqual({ groupId: GROUP })
    await upsert(leg("funds", "failed", { swapOutput: undefined, ...unsent }))
    await click("[title='Send remaining funds']")
    expect(freshModal.mock.lastCall![0].resume).toEqual({ groupId: GROUP, fundsAsset: "DAI" })
  })

  it("lists a row per leg in the group detail, and the rerun after a failed funds leg", async () => {
    await render(leg("gas", "done", quoted), leg("funds", "failed", { ...quoted, ...unsent }))
    await click("[data-testid=row-text]")
    expect(texts("[data-leg]")).toEqual(["Gas~0.5\u00a0ETH-$5.35 Paid", "Funds-$100.50 Failed"])
    expect(attrs("[data-leg] [data-tone]", "data-tone")).toEqual(["done", "failed"])
    expect(texts("dialog .ww-sheet__fact")[0]).toBe("Status Failed")
    expect(texts("dialog button:not([data-leg])")).toEqual(["Send remaining funds"])
  })

  it("names the missing funds leg in the group detail while the gas row stays paid", async () => {
    await render(paidGas)
    await click("[data-testid=row-text]")
    expect(texts("dialog .ww-sheet__fact")[0]).toBe("Status Funds not sent")
    expect(texts("[data-leg]")).toEqual(["Gas-$5.35 Paid"])
    expect(texts("dialog button:not([data-leg])")).toEqual(["Send remaining funds"])
  })

  it("opens a leg's own detail from its row, where its exit lives", async () => {
    await render(paidGas, leg("funds", "swapping", { ...escrowed, phaseEnteredAt: 0 }))
    await click("[data-testid=row-text]")
    expect(texts("dialog button")).toEqual(["Gas-$5.35 Paid", "Funds-$100.50 Swapping"])
    expect(texts("dialog .ww-sheet__note")).toEqual([expect.stringContaining("swap escrow")])
    await click("[data-leg=funds]")
    expect(texts("dialog button")).toContain("Run swap manually")
  })

  it("still renders an ungrouped withdrawal as the plain row", async () => {
    const rows = await render(leg("gas", "l2_mined", plain))
    expect(rows).toEqual(["Ghost | Withdrawal | -$5.35 | Releasing"])
  })
})

describe("a bell alert opened on its withdrawal", () => {
  const onBridge = { type: "bridge.txDetail", bridgeKind: "withdrawal", sourceId: "w_gas" }
  const onBurn = { type: "reorg.txDetail", txHash: BURN }

  /** Taps the bell's error entry, and returns the notice its sheet shows. */
  async function open(title: string, id: string, target: object, record: WithdrawalRecord) {
    const entry = { id, title, description: "Details", severity: "error", target }
    opened = notificationRoute(entry as AppNotificationEntry)?.state
    await render(record)
    return texts(".ww-txd__notice")
  }

  it.each([
    ["a withdrawal", "Withdrawal failed", "bridge:withdrawal:w_gas:failed", onBridge, plain],
    ["a fresh-address group", "Payment failed", `reorg:failed:${BURN}:0`, onBurn, {}],
  ])("shows a failure alert on %s only while it is failed", async (_on, title, id, target, as) => {
    const notice = await open(title, id, target, leg("gas", "failed", as))
    expect(notice).toEqual([`${title}: Details`])
    await upsert(leg("gas", "l2_mined", as))
    expect(texts(".ww-txd__notice")).toEqual([])
  })

  it("keeps a notice that is not a failure on a withdrawal that is not failed", async () => {
    const id = `bridge:withdrawal-group:${GROUP}:remaining`
    const notice = await open("Funds not sent", id, onBridge, leg("gas", "l2_mined"))
    expect(notice).toEqual(["Funds not sent: Details"])
  })
})

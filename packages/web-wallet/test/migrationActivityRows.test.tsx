/**
 * A migration shows in Activity as two rows off the real feed: its exit on the withdrawal rail until
 * the release lands, and its arrival on the deposit rail from the burn on, funded or not. An
 * arrival whose burn failed never receives anything, so it does not show.
 */
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  SIPADepositStore,
  UpgradeActivity,
  type SIPADepositRecord,
  type WithdrawalPhase,
  type WithdrawalRecord,
} from "@obsidion/front-core"

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

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
  ActivityListRow: (p: {
    counterparty: string
    counterpartyBadge?: string
    amount: string
    statusLabel?: string
    timestamp: string
  }) => (
    <p data-testid="row" data-time={p.timestamp}>
      {[p.counterparty, p.counterpartyBadge, p.amount, p.statusLabel].filter(Boolean).join(" | ")}
    </p>
  ),
}))
vi.mock("../src/features/paylink/usePaylinkDeps", () => ({ usePaylinkDeps: () => undefined }))
vi.mock("../src/features/paylink/chainTime", () => ({ usePolledChainSeconds: () => undefined }))
/** The tag a SIPA registered for this wallet; none for the migration rows. */
const registrationTag = vi.hoisted(() => ({ value: undefined as string | undefined }))
/** The pending registration's own feed row, when the registration record has one to show. */
const registrationEntry = vi.hoisted(() => ({
  value: null as null | { ts: number; sipaAddress: string; node: unknown; modal: null },
}))
vi.mock("../src/features/onboarding/useRegistrationDepositEntry", () => ({
  registrationTagForSipa: () => registrationTag.value,
  registrationTagForDeposit: () => registrationTag.value,
  useRegistrationDepositEntry: () => registrationEntry.value,
}))
vi.mock("../src/features/withdraw/withdrawFunnel", () => ({ reportWithdrawFunnel: () => {} }))

const { useActivityEntries } = await import("../src/ui/screens/useActivityEntries")
const { STUCK_SUBLINE } = await import("../src/ui/screens/activityView")
const { getWithdrawalStore } = await import("../src/features/withdraw/withdrawGateway")
const { webStorage } = await import("../src/platform/storage/WebStorageAdapter")

const SIPA = `0x${"5a".repeat(20)}` as const
const withdrawals = getWithdrawalStore()
const deposits = SIPADepositStore.get(webStorage)

/** 85 gross, 0.1 tip, 0.05 old-portal cut, 0.3 arrival fee: 84.55 reaches the new balance. */
function burn(phase: WithdrawalPhase, endTime?: number): WithdrawalRecord {
  return {
    localId: "m1",
    intent: "migration",
    recipient: SIPA,
    recipientProvenance: "saved-recipient",
    recipientAlias: "Your balance on the new version",
    amount: "85",
    rawAmount: (85n * 10n ** 18n).toString(),
    relayerTip: (10n ** 17n).toString(),
    fpcFundingCut: (5n * 10n ** 16n).toString(),
    arrivalFee: (3n * 10n ** 17n).toString(),
    tokenSymbol: "DAI",
    phase,
    startTime: 1_000,
    endTime,
    l2TxHash: `0x${"b0".repeat(32)}`,
  }
}

const arrival = (patch: Partial<SIPADepositRecord> = {}) =>
  deposits.upsert(
    SIPA,
    { phase: "broadcast", ...patch },
    {
      recipientL2Address: `0x${"01".repeat(32)}`,
      messageSecret: "0x01",
      recipientHash: "0x02",
      recoveryAddress: `0x${"03".repeat(20)}`,
      l1ChainId: 31337,
      amount: "0",
      tokenSymbol: "DAI",
      startTime: 2_000,
    },
  )

function Feed() {
  const { entries } = useActivityEntries()
  return (
    <>
      {entries.map((e) => (
        <React.Fragment key={e.id}>{e.node}</React.Fragment>
      ))}
    </>
  )
}

function Arriving() {
  return <p data-testid="arriving">{useActivityEntries().arriving.main.toString()}</p>
}

let container: HTMLDivElement
let root: Root

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  await withdrawals.clearAll()
  await deposits.clearAll()
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

async function rows(): Promise<string[]> {
  await act(async () => {
    root.render(
      <MemoryRouter>
        <Feed />
      </MemoryRouter>,
    )
  })
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
  return [...container.querySelectorAll('[data-testid="row"]')].map((r) => r.textContent ?? "")
}

const stamps = () =>
  [...container.querySelectorAll('[data-testid="row"]')].map((r) => r.getAttribute("data-time"))

describe("arriving funds", () => {
  const net = (8455n * 10n ** 18n) / 100n
  const arriving = async () => {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <Arriving />
        </MemoryRouter>,
      )
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    return container.querySelector('[data-testid="arriving"]')?.textContent
  }

  it("counts a migration in Main from its burn", async () => {
    await withdrawals.create(burn("l2_mined"))
    await arrival()
    expect(await arriving()).toBe(net.toString())
  })

  it("counts a swept deposit the feed hides behind the burn from this wallet that paid it", async () => {
    await withdrawals.create({ ...burn("l2_mined"), intent: "registration" })
    await arrival({ phase: "pendingClaim", amount: "84.55", netAmount: net.toString() })
    expect((await rows()).some((row) => row.includes("+$84.55"))).toBe(false)
    expect(await arriving()).toBe(net.toString())
  })
})

describe("migration activity rows", () => {
  it("shows the exit leaving the old network and the arrival it brings, from the burn on", async () => {
    await withdrawals.create(burn("l2_mined"))
    await arrival()
    const shown = await rows()
    // The arrival sits directly above its exit and reads as what it brings. Nothing has reached the
    // address yet, so it offers no exit and never reads as stuck, however long the burn takes.
    expect(shown).toEqual([
      "Upgrade | Arriving on new version | +$84.55 | Pending",
      expect.stringMatching(/^Upgrade \| Leaving old version/),
    ])
    const [arrivalStamp, exitStamp] = stamps()
    expect(exitStamp).toBe(STUCK_SUBLINE)
    expect(arrivalStamp).not.toBe(STUCK_SUBLINE)
  })

  it("shows no figure for a pending arrival whose fee is unknown", async () => {
    await withdrawals.create({ ...burn("l2_mined"), arrivalFee: undefined })
    await arrival()
    const shown = await rows()
    expect(shown[0]).toBe("Upgrade | Arriving on new version | Pending")
  })

  it("keeps the released exit as a finished leg below the claimed arrival", async () => {
    await withdrawals.create(burn("done", 5_000))
    await arrival({ phase: "claimed", amount: "84.5" })
    const shown = await rows()
    expect(shown).toEqual([
      expect.stringMatching(/^Upgrade \| Arrived/),
      "Upgrade | Left old version | -$85",
    ])
    const [arrivalStamp, exitStamp] = stamps()
    expect(arrivalStamp).toBe(exitStamp)
  })

  it("hides the unfunded arrival of a burn that failed", async () => {
    await withdrawals.create(burn("failed"))
    await arrival()
    const shown = await rows()
    expect(shown.some((r) => r.includes("Arriv"))).toBe(false)
  })

  // An upgrade's first refund rides its bootstrap, not a burn, to the update-metadata SIPA.
  it("shows an upgrade's first refund as an arrival with no exit", async () => {
    await arrival({ phase: "claimed", amount: "9.5", intent: "metadata" })
    expect(await rows()).toEqual(["Upgrade | Arrived | $9.50"])
  })

  // A burn failed locally after a lost hash stamp may still release on chain.
  it("shows a funded arrival behind a failed burn", async () => {
    await withdrawals.create(burn("failed"))
    await arrival({ phase: "recoverable", amount: "84.5" })
    const shown = await rows()
    expect(shown).toContainEqual(expect.stringMatching(/^Upgrade \| Arriving on new version/))
  })
})

// A later refund batch of an upgrade rides its own send, not a burn, to its own deposit address.
// An upgrade is one row over its batches; each batch's deposit is one of its legs.
describe("an upgrade's row", () => {
  const RUN = "metadata-migration/0xnew/0xold/0xaccount"
  const SECOND = `0x${"6b".repeat(20)}` as const
  const upgrades = UpgradeActivity.get(webStorage)
  const batch = async (id: string, patch: Record<string, unknown>) => {
    await webStorage.setItem(RUN, JSON.stringify({ phase: "arriving" }))
    await webStorage.setItem(
      `${RUN}/source/${id}`,
      JSON.stringify({
        binding: "b",
        recipient: SIPA,
        amount: (10n * 10n ** 18n).toString(),
        exitFee: (10n ** 17n).toString(),
        fromBlock: "1",
        createdAt: 1_000,
        sourceSelection: ["n"],
        ...patch,
      }),
    )
    await upgrades.addRun(RUN)
  }
  afterEach(async () => {
    await webStorage.setItem("metadata-migration/runs", "[]")
    await upgrades.changed()
  })

  it("shows nowhere until a batch is sent", async () => {
    await batch("remaining-0", {})
    await arrival()
    expect(await rows()).toEqual([])
  })

  it("is one row over every batch and the deposit it brings, until each has arrived", async () => {
    await batch("remaining-0", { broadcastTx: "0xa", sentAt: 1_500, received: true })
    await batch("remaining-1", { recipient: SECOND, broadcastTx: "0xb", sentAt: 1_600 })
    await arrival({ phase: "claimed", amount: "9.9", netAmount: (99n * 10n ** 17n).toString() })
    expect(await rows()).toEqual(["Upgrade | 1 of 2 arrived | +$19.80 | Pending"])
  })

  it("never reads a deposit recovered to Ethereum as arrived", async () => {
    await batch("remaining-0", { broadcastTx: "0xa", sentAt: 1_500, received: true })
    await arrival({ phase: "recovered", amount: "9.9" })
    expect(await rows()).toEqual([expect.stringMatching(/^Upgrade \| 0 of 1 arrived/)])
  })

  it("completes once every batch's deposit has arrived", async () => {
    await batch("remaining-0", { broadcastTx: "0xa", sentAt: 1_500, received: true })
    await arrival({ phase: "claimed", amount: "9.9", netAmount: (99n * 10n ** 17n).toString() })
    expect(await rows()).toEqual(["Upgrade | 1 transfer | +$9.90"])
  })
})

// The burn a golden ticket's claim sends to the registration's own deposit address is one leg of
// the registration, whose row (and the bell) reports it; the feed shows the burn on its own only
// while it needs a hand.
describe("a registration's funding burn", () => {
  const fund = (phase: WithdrawalPhase, startTime: number): WithdrawalRecord => ({
    ...burn(phase),
    localId: "r1",
    intent: "registration",
    recipientAlias: undefined,
    amount: "0.61",
    rawAmount: (61n * 10n ** 16n).toString(),
    startTime,
  })
  beforeEach(() => {
    registrationTag.value = "alice"
  })
  afterEach(() => {
    registrationTag.value = undefined
  })

  const registrationRow = expect.stringMatching(/^@alice \| Registration \| -\$0\.61/)

  it("is the registration's row, what left the balance, while it moves and once released", async () => {
    await withdrawals.create(fund("l2_mined", Date.now()))
    expect(await rows()).toEqual([registrationRow])
    await withdrawals.patch("r1", { phase: "done", endTime: Date.now() })
    expect(await rows()).toEqual([registrationRow])
  })

  it("keeps its row while it is stalled or failed", async () => {
    await withdrawals.create(fund("finalizing_l1", 1_000))
    expect(await rows()).toEqual([registrationRow])
    await withdrawals.patch("r1", { phase: "failed" })
    expect(await rows()).toEqual([registrationRow])
  })

  it("stands in for the pending registration's own row", async () => {
    registrationEntry.value = {
      ts: 3_000,
      sipaAddress: SIPA.toUpperCase().replace("0X", "0x"),
      node: <p data-testid="row">@alice | Registration | Detecting</p>,
      modal: null,
    }
    try {
      expect(await rows()).toEqual([expect.stringContaining("Detecting")])
      await withdrawals.create(fund("l2_mined", Date.now()))
      expect(await rows()).toEqual([registrationRow])
    } finally {
      registrationEntry.value = null
    }
  })

  it("is the registration's one leg: the deposit rail's stays behind it, swept or not", async () => {
    await withdrawals.create(fund("done", 1_000))
    // Funded and sweeping: a deposit figure here would repeat what the burn row shows.
    await arrival({ phase: "sweeping", amount: "0.61", startTime: Date.now() })
    expect(await rows()).toEqual([registrationRow])
    await deposits.clearAll()
    // Swept and credited: the return is cents, the sheet's note rather than a row.
    await arrival({ phase: "claimed", amount: "0.61", netAmount: "0.05", startTime: 3_000 })
    expect(await rows()).toEqual([registrationRow])
  })

  it("shows the deposit rail's leg early when it needs a hand", async () => {
    await withdrawals.create(fund("done", 1_000))
    await arrival({ phase: "recoverable", amount: "0.61", startTime: 3_000 })
    const shown = await rows()
    expect(shown).toHaveLength(2)
    expect(shown).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^@alice \| Registration \| \$0\.61 \| Needs recovery/),
        registrationRow,
      ]),
    )
  })
})

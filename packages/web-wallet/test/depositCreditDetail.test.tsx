/** An address that credited two tokens shows two rows, and each opens its own token's detail. */
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Address } from "viem"
import { SIPADepositStore, type SIPADepositRecord } from "@obsidion/front-core"

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

vi.mock("../src/config/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config/env")>()),
  getConfig: () => ({ oxideProfile: { portal: "0xcurrent" } }),
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
  ActivityListRow: (p: { counterparty: string; onClick?: () => void }) => (
    <button data-testid="row" onClick={p.onClick}>
      {p.counterparty}
    </button>
  ),
}))
vi.mock("../src/ui/screens/DepositDetailModal", () => ({
  DepositDetailModal: (p: { record: SIPADepositRecord }) => (
    <p data-testid="detail">{`${p.record.tokenSymbol} ${p.record.amount}`}</p>
  ),
  TagPurchaseModal: () => null,
}))
vi.mock("../src/features/paylink/usePaylinkDeps", () => ({ usePaylinkDeps: () => undefined }))
vi.mock("../src/features/paylink/chainTime", () => ({ usePolledChainSeconds: () => undefined }))
vi.mock("../src/features/onboarding/useRegistrationDepositEntry", () => ({
  registrationTagForSipa: () => undefined,
  registrationTagForDeposit: () => undefined,
  useRegistrationDepositEntry: () => null,
}))
vi.mock("../src/features/withdraw/withdrawFunnel", () => ({ reportWithdrawFunnel: () => {} }))
vi.mock("../src/features/deposit/loadDepositFacts", async (importOriginal) => {
  const { mockLoadDepositFacts, savingsRowTokens } = await import("./support/depositTokens")
  const tokens = savingsRowTokens()
  return mockLoadDepositFacts(importOriginal, () => tokens)
})

const { useActivityEntries } = await import("../src/ui/screens/useActivityEntries")
const { getWithdrawalStore } = await import("../src/features/withdraw/withdrawGateway")
const { webStorage } = await import("../src/platform/storage/WebStorageAdapter")
const { ROW_DAI: DAI, ROW_SUSDS: SUSDS } = await import("./support/depositTokens")

const SIPA = `0x${"5a".repeat(20)}` as const
const deposits = SIPADepositStore.get(webStorage)

function Feed() {
  const { entries, detailModals } = useActivityEntries()
  return (
    <>
      {entries.map((e) => (
        <React.Fragment key={e.id}>{e.node}</React.Fragment>
      ))}
      {detailModals}
    </>
  )
}

let container: HTMLDivElement
let root: Root

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  await getWithdrawalStore().clearAll()
  await deposits.clearAll()
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

const sweep = (
  inboxIndex: string,
  tokenAddress: Address,
  tokenSymbol: string,
  netAmount: bigint,
) => ({
  inboxIndex,
  sweepTxHash: `0x${inboxIndex.repeat(64)}` as const,
  netAmount: netAmount.toString(),
  tokenAddress,
  tokenSymbol,
  tokenDecimals: 18,
})

const SWEPT_TWICE: Partial<SIPADepositRecord> = {
  phase: "claimed",
  tokenAddress: SUSDS,
  tokenSymbol: "sUSDS",
  tokenDecimals: 18,
  amount: "2",
  netAmount: (2n * 10n ** 18n).toString(),
  inboxIndex: "8",
  claimedInboxIndexes: ["7", "8"],
  sweeps: [sweep("7", DAI, "DAI", 5n * 10n ** 18n), sweep("8", SUSDS, "sUSDS", 2n * 10n ** 18n)],
}

const save = (patch: Partial<SIPADepositRecord>) =>
  deposits.upsert(
    SIPA,
    { phase: "claimed", ...patch },
    {
      recipientL2Address: `0x${"01".repeat(32)}`,
      messageSecret: "0x01",
      recipientHash: "0x02",
      recoveryAddress: `0x${"03".repeat(20)}`,
      l1ChainId: 31337,
      amount: "0",
      tokenSymbol: "sUSDS",
      startTime: 2_000,
    },
  )

async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

async function render() {
  await act(async () => {
    root.render(
      <MemoryRouter>
        <Feed />
      </MemoryRouter>,
    )
  })
  await settle()
  return [...container.querySelectorAll<HTMLButtonElement>('[data-testid="row"]')]
}

const detail = () => container.querySelector('[data-testid="detail"]')?.textContent

describe("a deposit address that credited two tokens", () => {
  it("opens each token's row on that token's detail", async () => {
    await save(SWEPT_TWICE)
    const rows = await render()
    expect(rows).toHaveLength(2)

    const opened: string[] = []
    for (const row of rows) {
      await act(async () => row.click())
      opened.push(detail() ?? "")
    }

    expect(opened.sort()).toEqual(["DAI 5", "sUSDS 2"])
  })

  it("keeps a token's detail open when another sweep makes it the address's latest", async () => {
    await save(SWEPT_TWICE)
    const rows = await render()
    for (const row of rows) {
      await act(async () => row.click())
      if (detail() === "DAI 5") break
    }
    expect(detail()).toBe("DAI 5")

    await act(async () => {
      await save({
        ...SWEPT_TWICE,
        tokenAddress: DAI,
        tokenSymbol: "DAI",
        amount: "3",
        netAmount: (3n * 10n ** 18n).toString(),
        inboxIndex: "9",
        claimedInboxIndexes: ["7", "8", "9"],
        sweeps: [...SWEPT_TWICE.sweeps!, sweep("9", DAI, "DAI", 3n * 10n ** 18n)],
      })
    })
    await settle()

    expect(detail()).toBe("DAI 3")
  })
})

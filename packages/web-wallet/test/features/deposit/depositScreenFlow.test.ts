// @vitest-environment node
/**
 * The deposit screen's flow over a wallet Store the test writes: the steps held across the connect
 * picker and the account grant, the sheet the deposit modal shows, and what holds new funding.
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Hex } from "viem"
import {
  createUnresolvedSends,
  memoryBackend,
  memoryStore,
  openDatabase,
  unresolvedSendState,
  type SipaDeposit,
} from "@obsidion/front-core"
import type { L1WalletView } from "../../../src/session/l1Wallet"
import {
  COPIED_MS,
  openDepositScreenFlow,
  type DepositScreenInputs,
} from "../../../src/features/deposit/DepositScreen/depositScreenFlow"
import {
  depositScreenStart,
  type DepositScreenState,
} from "../../../src/features/deposit/DepositScreen/depositScreenTransition"
import {
  selectDepositHold,
  selectEntry,
  selectEntrySheet,
} from "../../../src/features/deposit/depositScreenView"
import type { SavedL1Wallet } from "../../../src/session/savedL1Wallets"
import type { SentDeposit } from "../../../src/features/deposit/DepositFromWalletModal/DepositFromWalletModal"

const ACCOUNT = `0x${"a1".repeat(20)}` as Hex
const OTHER = `0x${"b2".repeat(20)}` as Hex
const SAVED = { address: OTHER, name: "Savings" } as SavedL1Wallet

const disconnected: L1WalletView = {
  account: null,
  accounts: [],
  chainId: null,
  walletName: null,
  connecting: false,
  reopening: false,
}

function world(
  initial: Partial<DepositScreenState> = {},
  inputs: Partial<DepositScreenInputs> = {},
) {
  const wallet = memoryStore<L1WalletView>(disconnected)
  const picker = { open: false }
  const resumed: unknown[][] = []
  const clearStart = vi.fn()
  const latest = (): DepositScreenInputs => ({
    bridgeMode: false,
    pickerShown: () => picker.open,
    resume: (...args) => void resumed.push(args),
    clearStart,
    ...inputs,
  })
  const flow = openDepositScreenFlow(
    {
      l1Wallet: { view: wallet.readonly },
      initial: {
        ...depositScreenStart(undefined, { picking: "closed", symbol: "DAI", now: 0 }),
        ...initial,
      },
    },
    latest,
  )
  const screen = new AbortController()
  flow.start(screen.signal)
  const connect = (account: Hex, accounts = [account]) =>
    wallet.set({ ...disconnected, account, accounts, chainId: 1, walletName: "Rabby" })
  return { wallet, picker, resumed, clearStart, flow, screen, connect }
}

afterEach(() => vi.useRealTimers())

describe("the deposit screen's held wallet steps", () => {
  it("carries a fund step on once the wallet the picker asked for connects", () => {
    const { flow, picker, resumed, connect } = world()
    flow.awaitConnect({ kind: "fund" })
    picker.open = true
    connect(ACCOUNT)
    expect(resumed).toEqual([["fund", undefined]])
    expect(flow.state.get().waits.connect).toBeUndefined()
  })

  it("drops the step when the picker closed before a wallet connected, so a later connection opens nothing", () => {
    const { flow, picker, resumed, connect } = world()
    flow.awaitConnect({ kind: "bridge" })
    picker.open = false
    connect(ACCOUNT)
    expect(resumed).toEqual([])
    expect(flow.state.get().waits.connect).toBeUndefined()
  })

  it("lands a wallet `connectAnother` reopens while wagmi has not told RainbowKit yet", () => {
    const { flow, wallet, resumed } = world()
    flow.awaitConnect({ kind: "pick" })
    wallet.set({ ...disconnected, reopening: true })
    wallet.set({ ...disconnected, reopening: true, account: ACCOUNT, accounts: [ACCOUNT] })
    expect(resumed).toEqual([["pick", undefined]])
  })

  it("carries a saved account's step on once the wallet grants it, and drops it on a disconnect", () => {
    const { flow, resumed, connect, wallet } = world()
    connect(ACCOUNT)
    flow.awaitAccount({ kind: "bridge", saved: SAVED })
    connect(ACCOUNT, [ACCOUNT, OTHER])
    expect(resumed).toEqual([["bridge", SAVED]])

    flow.awaitAccount({ kind: "fund", saved: { ...SAVED, address: `0x${"c3".repeat(20)}` } })
    wallet.set(disconnected)
    expect(flow.state.get().waits.account).toBeUndefined()
    expect(resumed).toHaveLength(1)
  })

  it("stops following the wallet once the screen goes", () => {
    const { flow, picker, resumed, connect, screen } = world()
    flow.awaitConnect({ kind: "fund" })
    screen.abort()
    picker.open = true
    connect(ACCOUNT)
    expect(resumed).toEqual([])
  })

  it("opens the deposit modal for each router start until the user acts on it", () => {
    const inputs: { startKey?: string } = { startKey: "k1" }
    const clearStart = vi.fn()
    const flow = openDepositScreenFlow(
      {
        l1Wallet: { view: memoryStore(disconnected).readonly },
        initial: depositScreenStart(undefined, { picking: "closed", symbol: "DAI", now: 0 }),
      },
      () => ({
        ...inputs,
        bridgeMode: false,
        pickerShown: () => false,
        resume: () => {},
        clearStart,
      }),
    )
    expect(selectEntry(flow.state.get(), inputs.startKey)).toEqual({})
    flow.close()
    expect(clearStart).toHaveBeenCalledOnce()
    expect(selectEntry(flow.state.get(), "k1")).toBeUndefined()
    // Deposit pressed again while the screen shows.
    expect(selectEntry(flow.state.get(), "k2")).toEqual({})
  })
})

describe("the deposit modal's sheet", () => {
  const sent = { address: "0xsipa", txHash: "0x01" } as unknown as SentDeposit

  it("shows the account switch over the sheet it was asked from, and the sheet once granted", () => {
    const { flow, connect } = world()
    connect(ACCOUNT)
    flow.open({ kind: "fund" })
    flow.awaitAccount({ kind: "fund", saved: SAVED })
    const wallet = { account: ACCOUNT, accounts: [ACCOUNT] }
    expect(selectEntrySheet(flow.state.get(), wallet)?.kind).toBe("switch")
    expect(
      selectEntrySheet(flow.state.get(), { account: ACCOUNT, accounts: [ACCOUNT, OTHER] })?.kind,
    ).toBe("fund")
  })

  it("follows the sender a modal from a saved wallet changes to, and drops it for another account", () => {
    const { flow } = world()
    flow.entry({ intent: "wallet", saved: { address: ACCOUNT, name: "Main" } as SavedL1Wallet })
    flow.sender(SAVED)
    expect(flow.state.get().entry).toEqual({ intent: "wallet", saved: SAVED })
    flow.sender(undefined)
    expect(flow.state.get().entry).toEqual({ intent: "wallet", saved: undefined })
  })

  it("opens nothing when the sender changes with no modal open", () => {
    const { flow } = world()
    flow.sender(SAVED)
    expect(flow.state.get().entry).toBeUndefined()
  })

  it("shows a sent deposit over everything, and one close event closes the modal and its sheets", () => {
    const { flow } = world()
    flow.entry({ intent: "wallet" })
    flow.carry({ amount: "20", side: "from" })
    flow.open({ kind: "sent", deposit: sent })
    flow.awaitAccount({ kind: "fund", saved: SAVED })
    expect(selectEntrySheet(flow.state.get(), { account: ACCOUNT, accounts: [ACCOUNT] })).toEqual({
      kind: "sent",
      deposit: sent,
    })
    flow.close()
    const s = flow.state.get()
    expect([s.entry, s.sheet, s.carried, s.waits.account]).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ])
  })

  it("waits for funds once the copied note has shown, unless the user went back to the address", () => {
    vi.useFakeTimers()
    const { flow } = world()
    flow.coin("DAI")
    flow.copied()
    vi.advanceTimersByTime(COPIED_MS)
    expect(flow.state.get().awaiting).toBe(true)

    flow.showAddress()
    flow.copied()
    flow.shut("address")
    vi.advanceTimersByTime(COPIED_MS)
    expect(flow.state.get().awaiting).toBe(false)
  })

  it("reopens the last coin's sheet where it was; another coin starts at its address", () => {
    const { flow } = world()
    flow.coin("DAI")
    flow.read(5n, 100)
    flow.coin("DAI")
    expect(flow.state.get()).toMatchObject({ balance: 5n, lastReadAt: 100 })
    flow.coin("USDC")
    expect(flow.state.get()).toMatchObject({
      balance: 0n,
      lastReadAt: undefined,
      sheetCoin: "USDC",
    })
  })

  it("keeps the first funding seen", () => {
    const { flow } = world()
    expect(flow.funded(7n)).toBe(true)
    expect(flow.funded(9n)).toBe(false)
    expect(flow.state.get().funded).toBe(7n)
  })
})

describe("what holds new funding", () => {
  const record = (sipaAddress: string, phase: SipaDeposit["phase"]) =>
    ({ sipaAddress, phase, heldBalance: "1" } as unknown as SipaDeposit)
  const sends = () =>
    createUnresolvedSends({ page: openDatabase(memoryBackend()), namespace: "test/" })

  it("holds on a saved send until funds reach its address, and shows that deposit until closed", async () => {
    const holds = sends()
    await holds.ready
    await holds.apply({ type: "held", send: { address: "0xsipa", at: 1 } })
    const saved = unresolvedSendState(holds.view.get())
    const empty = { held: undefined, closedArrival: undefined }
    expect(selectDepositHold(empty, saved, []).hold.status).toBe("held")

    const funded = [record("0xsipa", "funded")]
    expect(selectDepositHold(empty, saved, funded)).toMatchObject({
      hold: { status: "none" },
      arrived: { sipaAddress: "0xsipa" },
    })
    expect(selectDepositHold({ ...empty, closedArrival: "0xsipa" }, saved, funded).arrived).toBe(
      undefined,
    )
  })

  it("holds this page on a send reported unresolved even when its saved hold is gone", () => {
    const held = { id: "send" as const, address: "0xsipa", at: 1 }
    expect(selectDepositHold({ held }, { status: "none" }, []).hold).toEqual({
      status: "held",
      send: held,
    })
  })
})

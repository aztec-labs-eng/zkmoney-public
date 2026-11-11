import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { getAddress, http, type Hex } from "viem"
import { foundry } from "viem/chains"
import { createConfig, mock, type Config } from "wagmi"
import { connect } from "wagmi/actions"
import { openL1Wallet, type L1Wallet } from "../../src/session/l1Wallet"

const A = getAddress(`0x${"a1".repeat(20)}`)
const B = getAddress(`0x${"b2".repeat(20)}`)
const C = getAddress(`0x${"c3".repeat(20)}`)

let wagmi: Config
let l1: L1Wallet
let unwatch: () => void

const connector = () => wagmi.connectors[0]!
const walletSwitched = (accounts: Hex[]) => connector().emitter.emit("change", { accounts })

beforeEach(async () => {
  wagmi = createConfig({
    chains: [foundry],
    connectors: [mock({ accounts: [A, B, C] })],
    multiInjectedProviderDiscovery: false,
    transports: { [foundry.id]: http() },
    storage: null,
  })
  l1 = openL1Wallet({ wagmi })
  unwatch = l1.view.subscribe(() => {})
  await connect(wagmi, { connector: connector() })
})

afterEach(() => unwatch())

describe("openL1Wallet: the picked account", () => {
  it("follows the wallet's first account until the app picks another", () => {
    expect(l1.view.get()).toMatchObject({ account: A, accounts: [A, B, C], chainId: foundry.id })
    l1.selectAccount(B)
    expect(l1.view.get().account).toBe(B)
  })

  it("keeps the pick while the wallet's active account stays", () => {
    l1.selectAccount(B)
    walletSwitched([A, B])
    expect(l1.view.get().account).toBe(B)
  })

  it("drops the pick for good once the wallet switches its active account", () => {
    l1.selectAccount(B)
    walletSwitched([C, A, B])
    expect(l1.view.get().account).toBe(C)
    walletSwitched([A, B, C])
    expect(l1.view.get().account).toBe(A)
  })

  it("drops the pick on disconnect", () => {
    l1.selectAccount(B)
    l1.disconnect()
    expect(l1.view.get()).toMatchObject({ account: null, accounts: [] })
  })
})

describe("openL1Wallet: connectAnother", () => {
  const shown = () => true

  it("drops the wallet while it opens the picker", async () => {
    let opened = () => {}
    const open = vi.fn(() => new Promise<void>((resolve) => (opened = resolve)))
    void l1.connectAnother(open, shown)
    expect(open).toHaveBeenCalledOnce()
    expect(l1.view.get()).toMatchObject({ account: null, reopening: true })
    opened()
    await vi.waitFor(() => expect(l1.view.get().reopening).toBe(false))
  })

  it("resolves with the wallet the open picker connects", async () => {
    const next = l1.connectAnother(() => {}, shown)
    await connect(wagmi, { connector: connector() })
    await expect(next).resolves.toEqual({
      account: A,
      chainId: foundry.id,
      walletName: connector().name,
    })
  })

  it("resolves undefined when a wallet connects after the picker closed", async () => {
    const next = l1.connectAnother(
      () => {},
      () => false,
    )
    await connect(wagmi, { connector: connector() })
    await expect(next).resolves.toBeUndefined()
  })

  it("resolves undefined when a later connectAnother replaced it", async () => {
    const first = l1.connectAnother(() => {}, shown)
    const second = l1.connectAnother(() => {}, shown)
    await expect(first).resolves.toBeUndefined()
    await connect(wagmi, { connector: connector() })
    await expect(second).resolves.toMatchObject({ account: A })
  })

  it("resolves undefined when its signal aborts", async () => {
    const ended = new AbortController()
    const next = l1.connectAnother(() => {}, shown, ended.signal)
    ended.abort()
    await expect(next).resolves.toBeUndefined()
  })
})

// @vitest-environment node
/** The past-user modal's flow over the page's real check and wagmi, with the list standing in. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Hex } from "viem"
import { createConfig, http, type Config } from "wagmi"
import { foundry } from "wagmi/chains"
import { WalletError } from "@obsidion/core/errors"
import { openVerifyPastUserFlow } from "../../../src/features/registration/verifyPastUserFlow"
import { closeSession } from "../../../src/session/session"
import { openTestSession } from "../../support/session"

const OLD = `0x3f${"00".repeat(17)}a91c` as Hex
const OTHER = `0x7a${"00".repeat(17)}0b2d` as Hex
const DEBOUNCE = 350

const wagmiConfig = () =>
  createConfig({
    chains: [foundry],
    connectors: [],
    multiInjectedProviderDiscovery: false,
    transports: { [foundry.id]: http() },
    storage: null,
  })

/** Connects `address` on `wagmi`'s own state, on `chainId`; undefined disconnects. */
function connectOn(wagmi: Config, address: Hex | undefined, chainId: number = foundry.id) {
  const connector = { id: "test", name: "Test", uid: "test", type: "test" } as never
  wagmi.setState((s) =>
    address
      ? {
          ...s,
          chainId,
          current: "test",
          status: "connected",
          connections: new Map([["test", { accounts: [address], chainId, connector }]]),
        }
      : { ...s, current: null, status: "disconnected", connections: new Map() },
  )
}
beforeEach(() => {
  vi.useFakeTimers()
  const tab = new Map<string, string>()
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => tab.get(key) ?? null,
    setItem: (key: string, value: string) => void tab.set(key, value),
    removeItem: (key: string) => void tab.delete(key),
  })
})
afterEach(() => {
  closeSession()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

/** A modal over the test session; the list's answers and the connected wallet are the test's. */
function modal(answers: Record<string, boolean | "fail"> = {}, claim = vi.fn()) {
  const session = openTestSession({
    account: { getAddress: () => ({ toString: () => "0xowner" }) },
    wallet: {},
  })
  const wagmi = wagmiConfig()
  const lookups: string[] = []
  const connect = vi.fn(async () => {})
  const flow = openVerifyPastUserFlow(
    {
      session,
      wagmi,
      claim,
      lookup: async (address) => {
        lookups.push(address)
        if (answers[address] === "fail") throw new Error("leaves unreachable")
        return answers[address] === true
      },
    },
    () => ({ connect }),
  )
  const ended = new AbortController()
  flow.start(ended.signal)
  /** The wallet connects `address`, as the picker would; undefined disconnects it. */
  const connects = (address: Hex | undefined, chainId?: number) =>
    connectOn(wagmi, address, chainId)
  return { flow, session, lookups, connect, connects, end: () => ended.abort() }
}

const lookupOf = (flow: ReturnType<typeof modal>["flow"]) => flow.view.get().lookup.kind

describe("the past-user modal", () => {
  it("reads text that can still become an address as idle, and other text as invalid", () => {
    const { flow, lookups } = modal()
    expect(lookupOf(flow)).toBe("idle")
    flow.type("0x3f")
    expect(lookupOf(flow)).toBe("idle")
    flow.type("hello")
    expect(lookupOf(flow)).toBe("invalid")
    expect(lookups).toEqual([])
  })

  it("looks up only the address that held for the debounce", async () => {
    const { flow, lookups } = modal({ [OLD]: true })
    flow.type(OTHER)
    await vi.advanceTimersByTimeAsync(DEBOUNCE - 1)
    flow.type(OLD)
    expect(lookupOf(flow)).toBe("loading")
    await vi.advanceTimersByTimeAsync(DEBOUNCE)
    expect(lookups).toEqual([OLD])
    expect(lookupOf(flow)).toBe("found")
  })

  it("reads an address off the list as not found", async () => {
    const { flow } = modal({ [OLD]: false })
    flow.type(OLD)
    await vi.advanceTimersByTimeAsync(DEBOUNCE)
    expect(lookupOf(flow)).toBe("not-found")
  })

  it("holds a failed lookup until its retry", async () => {
    const answers: Record<string, boolean | "fail"> = { [OLD]: "fail" }
    const { flow, lookups } = modal(answers)
    flow.type(OLD)
    await vi.advanceTimersByTimeAsync(DEBOUNCE * 4)
    expect(lookupOf(flow)).toBe("error")
    expect(lookups).toHaveLength(1)

    answers[OLD] = true
    flow.retry()
    expect(lookupOf(flow)).toBe("loading")
    await vi.advanceTimersByTimeAsync(DEBOUNCE)
    expect(lookupOf(flow)).toBe("found")
  })

  it("fills the connected wallet's address, or asks for one and fills it once it connects", () => {
    const { flow, connect, connects } = modal()
    connects(OLD)
    flow.connectWallet()
    expect(flow.view.get().address).toBe(OLD)
    expect(connect).not.toHaveBeenCalled()

    connects(undefined)
    flow.type("")
    flow.connectWallet()
    expect(connect).toHaveBeenCalledTimes(1)
    connects(OTHER)
    expect(flow.view.get().address).toBe(OTHER)
  })

  it("signs with the typed wallet once it connects, and checks another one first", () => {
    const { flow, session, connects, connect } = modal()
    flow.type(OLD)
    flow.sign()
    expect(connect).toHaveBeenCalledTimes(1)
    connects(OTHER)
    expect(flow.view.get().address).toBe(OTHER)
    expect(session.pastUser.state.get().check).toBeUndefined()

    flow.sign()
    expect(session.pastUser.state.get().check).toMatchObject({ step: "sign", account: OTHER })
  })

  it("waits out a chain switch, then signs once the typed wallet connects", () => {
    const { flow, session, connects } = modal()
    flow.type(OLD)
    connects(OTHER)
    flow.sign()
    // A chain switch is no new wallet: nothing fills and nothing signs.
    connects(OTHER, 1)
    expect(flow.view.get().address).toBe(OLD)
    expect(session.pastUser.state.get().check).toBeUndefined()
    connects(OLD)
    expect(session.pastUser.state.get().check).toMatchObject({ step: "sign", account: OLD })
  })

  it("opens on the address of the check the account passed", () => {
    sessionStorage.setItem(
      "zkm.pastUserCheck.0xowner",
      JSON.stringify({ step: "confirmed", account: OLD }),
    )
    expect(modal().flow.view.get().address).toBe(OLD)
  })

  it("looks up again after a start that was aborted and replayed", async () => {
    const { flow, lookups, end } = modal({ [OLD]: true })
    end()
    flow.start(new AbortController().signal)
    flow.type(OLD)
    await vi.advanceTimersByTimeAsync(DEBOUNCE)
    expect(lookups).toEqual([OLD])
    expect(lookupOf(flow)).toBe("found")
  })

  it("keeps a failed free claim's error and lets it be tried again", async () => {
    const refused = new WalletError("unknown")
    const claim = vi.fn(() => {
      throw refused
    })
    const { flow } = modal({}, claim)
    await flow.claimTag("alice")
    expect(flow.view.get()).toMatchObject({ claiming: false, error: refused })
    await flow.claimTag("alice")
    expect(claim).toHaveBeenCalledTimes(2)
  })

  it("looks nothing up once the modal closes", async () => {
    const { flow, lookups, end } = modal({ [OLD]: true })
    flow.type(OLD)
    end()
    await vi.advanceTimersByTimeAsync(DEBOUNCE * 4)
    expect(lookups).toEqual([])
  })
})

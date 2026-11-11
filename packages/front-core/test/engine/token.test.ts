// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest"
import { WALLET_TOKEN_SYMBOL } from "@obsidion/core/constants"
import type { RegisteredTeeSigner, TokenService } from "@obsidion/sdk"
import { fixed, valueOf, type Service } from "../../src/engine/service"
import { memoryStore, type Store } from "../../src/engine/store"
import { openTeeSigner, openToken } from "../../src/engine/token"
import type { TeeSignerSource } from "../../src/tee/teeSignerSource"
import { fakeClock, flush, later } from "./taskTable"

const signer = (registry: string) =>
  ({ teeRegistry: { toString: () => registry } } as unknown as RegisteredTeeSigner)
const SIGNER = signer("0xtee-registry")
const TOKEN = "0xtoken"

function fakeSource(overrides: Partial<TeeSignerSource> = {}) {
  const listeners = new Set<() => void>()
  const source = {
    label: "fake-source",
    load: vi.fn(async (): Promise<RegisteredTeeSigner | undefined> => SIGNER),
    subscribe: vi.fn((cb: () => void) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    }),
    refresh: vi.fn(),
    ...overrides,
  }
  // Iterates the live set, as the manifest client does: a listener added during the call runs too.
  return { source, emit: () => listeners.forEach((l) => l()) }
}

function fakeToken() {
  const info = { address: TOKEN, name: "Main", symbol: WALLET_TOKEN_SYMBOL, decimals: 18 }
  return {
    setTeeSigner: vi.fn(),
    fetchTokenInformation: vi.fn(async () => info),
    metadata: info,
    tokenAddressOrNull: { toString: () => TOKEN },
  }
}

/** The assets' `when`: the routes that need them set it. */
let wanted: Store<boolean>
beforeEach(() => void (wanted = memoryStore(false)))
const start = () => wanted.set(true)

function setup(
  teeSigner: Service<RegisteredTeeSigner> | ReturnType<typeof openTeeSigner>,
  account: Service<object> = fixed("account", {}),
) {
  const tokens: ReturnType<typeof fakeToken>[] = []
  const create = vi.fn(async () => {
    const token = fakeToken()
    tokens.push(token)
    return token as unknown as TokenService
  })
  const token = openToken({
    wallet: fixed("wallet", {} as never),
    account: account as never,
    contractService: fixed("contractService", {} as never),
    teeSigner,
    when: wanted,
    create,
  })
  return { token, tokens, create }
}

fakeClock()

describe("openTeeSigner", () => {
  it("connects nothing before `when` holds, then logs the connect with the source's label", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {})
    const { source } = fakeSource()
    const tee = openTeeSigner(source, wanted)
    await flush()
    expect(source.load).not.toHaveBeenCalled()
    start()
    await flush()
    expect(valueOf(tee)).toBe(SIGNER)
    expect(log).toHaveBeenCalledWith(
      "[teeSigner] connected",
      expect.objectContaining({ teeRegistry: "0xtee-registry", source: "fake-source" }),
    )
  })

  it("stays pending when the source has nothing to connect, asking no refresh", async () => {
    const { source } = fakeSource({ load: vi.fn(async () => undefined) })
    const tee = openTeeSigner(source, wanted)
    start()
    await flush()
    expect(tee.get().status).toBe("pending")
    expect(source.refresh).not.toHaveBeenCalled()
  })

  it("fails with the error, asks the source to refresh, and connects on the retry", async () => {
    const failure = new Error("enclave hiccup")
    const load = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(SIGNER)
    const { source } = fakeSource({ load, subscribe: undefined })
    const tee = openTeeSigner(source, wanted)
    start()
    await flush()
    expect(tee.get()).toMatchObject({ status: "failed", error: failure })
    expect(source.refresh).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(4_000)
    expect(load).toHaveBeenCalledTimes(2)
    expect(valueOf(tee)).toBe(SIGNER)
  })

  it("bounds a hung connect at 60 s, then retries", async () => {
    const load = vi
      .fn()
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValue(SIGNER)
    const tee = openTeeSigner(fakeSource({ load, subscribe: undefined }).source, wanted)
    start()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(tee.get()).toMatchObject({
      status: "failed",
      error: expect.objectContaining({ code: "timeout" }),
    })
    await vi.advanceTimersByTimeAsync(4_000)
    expect(valueOf(tee)).toBe(SIGNER)
  })

  it("reconnects on a manifest roll, clearing the signer from the token first", async () => {
    const B = signer("0xtee-registry-B")
    const { source, emit } = fakeSource()
    const tee = openTeeSigner(source, wanted)
    const { tokens } = setup(tee)
    start()
    await flush()
    expect(tokens[0].setTeeSigner).toHaveBeenLastCalledWith(SIGNER)
    vi.mocked(source.load).mockResolvedValueOnce(B)
    emit()
    expect(tokens[0].setTeeSigner).toHaveBeenLastCalledWith(undefined)
    await flush()
    expect(valueOf(tee)).toBe(B)
    expect(source.load).toHaveBeenCalledTimes(2)
    expect(tokens[0].setTeeSigner).toHaveBeenLastCalledWith(B)
  })

  it("stops its retry and its subscription on close", async () => {
    const unsubscribe = vi.fn()
    const load = vi.fn().mockRejectedValue(new Error("down"))
    const tee = openTeeSigner(
      fakeSource({ load, subscribe: vi.fn(() => unsubscribe) }).source,
      wanted,
    )
    start()
    await flush()
    tee.close()
    expect(unsubscribe).toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(300_000)
    expect(load).toHaveBeenCalledTimes(1)
  })

  it("connects with no account behind it: a link's visitor cashing out", async () => {
    const tee = openTeeSigner(fakeSource().source, wanted)
    const { create } = setup(tee, later<object>("account").service)
    start()
    await flush()
    expect(valueOf(tee)).toBe(SIGNER)
    expect(create).not.toHaveBeenCalled()
  })
})

describe("openToken", () => {
  it("builds nothing before `when` holds", async () => {
    const { token, create } = setup(fixed("teeSigner", SIGNER))
    await flush()
    expect(create).not.toHaveBeenCalled()
    start()
    await flush()
    expect(valueOf(token)).toBeDefined()
  })

  it("builds once a late account arrives, and hands it the signer connected before", async () => {
    const account = later<object>("account")
    const { token, tokens } = setup(fixed("teeSigner", SIGNER), account.service)
    start()
    await flush()
    expect(token.get().status).toBe("pending")
    account.ready({})
    await flush()
    expect(tokens[0].fetchTokenInformation).toHaveBeenCalled()
    expect(tokens[0].setTeeSigner).toHaveBeenCalledWith(SIGNER)
  })

  it("gives the signer only to the current token", async () => {
    const account = later<object>("account")
    account.ready({})
    const { tokens } = setup(fixed("teeSigner", SIGNER), account.service)
    start()
    await flush()
    account.ready({})
    await flush()
    expect(tokens).toHaveLength(2)
    expect(tokens[0].setTeeSigner).toHaveBeenLastCalledWith(undefined)
    expect(tokens[1].setTeeSigner).toHaveBeenLastCalledWith(SIGNER)
  })

  it("retries a failed metadata read with a backoff", async () => {
    const { token, tokens, create } = setup(fixed("teeSigner", SIGNER))
    create.mockImplementationOnce(async () => {
      const t = fakeToken()
      t.fetchTokenInformation.mockRejectedValueOnce(new Error("L1 unreachable"))
      tokens.push(t)
      return t as unknown as TokenService
    })
    start()
    await flush()
    expect(token.get().status).toBe("failed")
    await vi.advanceTimersByTimeAsync(4_000)
    expect(valueOf(token)).toBe(tokens[1])
  })
})

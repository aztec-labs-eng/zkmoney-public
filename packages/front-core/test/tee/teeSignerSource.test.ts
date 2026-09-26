import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { sepolia } from "viem/chains"

// ---------------------------------------------------------------------------
// `teeSignerSource` covers the oxide-vs-sandbox connect decision that used to
// live inside `useAsset`. The oxide source reads the enclave URL + portal from
// ONE manifest-tuple snapshot (atomicity), guards a malformed portal, and
// wires subscribe/refresh through the oxide client; the sandbox source is a
// static proxy to the relayer.
// ---------------------------------------------------------------------------

const { loadTeeSignerMock, oxideClientHolder } = vi.hoisted(() => ({
  loadTeeSignerMock: vi.fn(),
  // Swappable so a test can simulate "no manifest for this environment".
  oxideClientHolder: { current: null as any },
}))

vi.mock("@obsidion/sdk", async () => {
  const actual = await vi.importActual<typeof import("@obsidion/sdk")>("@obsidion/sdk")
  return {
    ...actual,
    ContractService: {
      getInstance: () => ({ getOxideClient: () => oxideClientHolder.current }),
    },
    loadTeeSigner: loadTeeSignerMock,
  }
})

import { createOxideTeeSignerSource } from "../../src/tee/teeSignerSource"

const FAKE_PORTAL = "0x10c20f5ec11aa51de97edd0cfb01bfcb11e8fbf3"
const FAKE_ENCLAVE_URL = "http://enclave/rpc"
const FAKE_SIGNER = { ethAddress: { toString: () => "0xenclave" } } as any

const makeTuple = (overrides: Record<string, string> = {}) =>
  Object.freeze({ portal: FAKE_PORTAL, enclaveUrl: FAKE_ENCLAVE_URL, ...overrides })

function makeFakeClient(tuple: any = null) {
  const listeners = new Set<(t: any) => void>()
  return {
    tuple,
    getCurrentTuple() {
      return this.tuple
    },
    subscribe(l: (t: any) => void) {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    refresh: vi.fn(async () => {}),
    apply(t: any) {
      this.tuple = t
      ;[...listeners].forEach((l) => l(t))
    },
  }
}

const L1_OPTS = { l1RpcUrl: "http://l1.rpc", l1Chain: sepolia }

describe("createOxideTeeSignerSource", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    oxideClientHolder.current = makeFakeClient()
  })
  afterEach(() => vi.restoreAllMocks())

  it("connects with portal AND enclaveUrl from the same tuple snapshot", async () => {
    loadTeeSignerMock.mockResolvedValueOnce(FAKE_SIGNER)
    oxideClientHolder.current = makeFakeClient(makeTuple())

    const source = createOxideTeeSignerSource(L1_OPTS)
    const signer = await source.load()

    expect(signer).toBe(FAKE_SIGNER)
    expect(loadTeeSignerMock).toHaveBeenCalledWith(
      FAKE_ENCLAVE_URL,
      FAKE_PORTAL,
      expect.any(Object),
    )
  })

  it("returns undefined (no connect) while no tuple is available", async () => {
    oxideClientHolder.current = makeFakeClient(null)
    const source = createOxideTeeSignerSource(L1_OPTS)

    expect(await source.load()).toBeUndefined()
    expect(loadTeeSignerMock).not.toHaveBeenCalled()
  })

  it("returns undefined when no oxide client exists for the environment", async () => {
    oxideClientHolder.current = null
    const source = createOxideTeeSignerSource(L1_OPTS)

    expect(await source.load()).toBeUndefined()
    expect(loadTeeSignerMock).not.toHaveBeenCalled()
  })

  it("skips and warns on a malformed portal", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    oxideClientHolder.current = makeFakeClient(makeTuple({ portal: "" }))

    const source = createOxideTeeSignerSource(L1_OPTS)
    expect(await source.load()).toBeUndefined()

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("portal address missing or malformed"),
      expect.objectContaining({ portal: "" }),
    )
    expect(loadTeeSignerMock).not.toHaveBeenCalled()
  })

  it("subscribe relays the oxide client's tuple-applied signal", () => {
    const client = makeFakeClient(makeTuple())
    oxideClientHolder.current = client
    const source = createOxideTeeSignerSource(L1_OPTS)

    const onChange = vi.fn()
    const unsubscribe = source.subscribe!(onChange)
    client.apply(makeTuple({ enclaveUrl: "http://enclave-B/rpc" }))
    expect(onChange).toHaveBeenCalledTimes(1)

    unsubscribe()
    client.apply(makeTuple())
    expect(onChange).toHaveBeenCalledTimes(1) // no longer notified
  })

  it("refresh asks the oxide client to re-fetch the manifest", () => {
    const client = makeFakeClient(makeTuple())
    oxideClientHolder.current = client
    const source = createOxideTeeSignerSource(L1_OPTS)

    source.refresh!()
    expect(client.refresh).toHaveBeenCalledTimes(1)
  })

  describe("L2 approval getters", () => {
    const FAKE_NODE = { __tag: "node" } as any
    const FAKE_TOKEN = { __tag: "token" } as any

    it("passes node and token address to loadTeeSigner as l2Approval", async () => {
      loadTeeSignerMock.mockResolvedValueOnce(FAKE_SIGNER)
      oxideClientHolder.current = makeFakeClient(makeTuple())
      const source = createOxideTeeSignerSource({
        ...L1_OPTS,
        getNode: () => FAKE_NODE,
        getTokenAddress: async () => FAKE_TOKEN,
      })

      expect(await source.load()).toBe(FAKE_SIGNER)
      expect(loadTeeSignerMock).toHaveBeenCalledWith(
        FAKE_ENCLAVE_URL,
        FAKE_PORTAL,
        expect.any(Object),
        { l2Approval: { node: FAKE_NODE, tokenAddress: FAKE_TOKEN } },
      )
    })

    it("skips the connect while the node is missing", async () => {
      oxideClientHolder.current = makeFakeClient(makeTuple())
      const source = createOxideTeeSignerSource({
        ...L1_OPTS,
        getNode: () => undefined,
        getTokenAddress: async () => FAKE_TOKEN,
      })

      expect(await source.load()).toBeUndefined()
      expect(loadTeeSignerMock).not.toHaveBeenCalled()
    })

    it("skips the connect while the token address is missing", async () => {
      oxideClientHolder.current = makeFakeClient(makeTuple())
      const source = createOxideTeeSignerSource({
        ...L1_OPTS,
        getNode: () => FAKE_NODE,
        getTokenAddress: async () => undefined,
      })

      expect(await source.load()).toBeUndefined()
      expect(loadTeeSignerMock).not.toHaveBeenCalled()
    })

    it("rethrows the connect-time refusal so the hook keeps retrying", async () => {
      const refusal = new Error("not approved")
      loadTeeSignerMock.mockRejectedValueOnce(refusal)
      oxideClientHolder.current = makeFakeClient(makeTuple())
      const source = createOxideTeeSignerSource({
        ...L1_OPTS,
        getNode: () => FAKE_NODE,
        getTokenAddress: async () => FAKE_TOKEN,
      })

      await expect(source.load()).rejects.toBe(refusal)
    })

    it("refuses a half-configured pair at construction", () => {
      expect(() => createOxideTeeSignerSource({ ...L1_OPTS, getNode: () => FAKE_NODE })).toThrow(
        /supplied together/,
      )
    })
  })

  it("reads a fresh tuple on each load (atomicity across rolls)", async () => {
    const client = makeFakeClient(makeTuple())
    oxideClientHolder.current = client
    loadTeeSignerMock.mockResolvedValue(FAKE_SIGNER)
    const source = createOxideTeeSignerSource(L1_OPTS)

    await source.load()
    client.apply(makeTuple({ enclaveUrl: "http://enclave-B/rpc" }))
    await source.load()

    expect(loadTeeSignerMock).toHaveBeenNthCalledWith(
      1,
      FAKE_ENCLAVE_URL,
      FAKE_PORTAL,
      expect.any(Object),
    )
    expect(loadTeeSignerMock).toHaveBeenNthCalledWith(
      2,
      "http://enclave-B/rpc",
      FAKE_PORTAL,
      expect.any(Object),
    )
  })
})

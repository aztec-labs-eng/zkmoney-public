import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { sepolia } from "viem/chains"

// ---------------------------------------------------------------------------
// The oxide source reads the enclave URL + portal from ONE manifest-tuple
// snapshot (atomicity), guards a malformed portal, and wires subscribe/refresh
// through the oxide client.
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

import { createOxideTeeSignerSource, sharedFleetSigners } from "../../src/tee/teeSignerSource"

const FAKE_PORTAL = "0x10c20f5ec11aa51de97edd0cfb01bfcb11e8fbf3"
const FAKE_ENCLAVE_URL = "http://enclave/rpc"
const FAKE_SIGNER = { teeRegistry: { toString: () => "0xregistry" } } as any

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

  it("rethrows a connect-time refusal so the hook keeps retrying", async () => {
    const refusal = new Error("not registered")
    loadTeeSignerMock.mockRejectedValueOnce(refusal)
    oxideClientHolder.current = makeFakeClient(makeTuple())
    const source = createOxideTeeSignerSource(L1_OPTS)

    await expect(source.load()).rejects.toBe(refusal)
  })

  it("connects to the caller's deployment and ignores the contract service's rolls", async () => {
    const VAULT_PORTAL = "0x20c20f5ec11aa51de97edd0cfb01bfcb11e8fbf4"
    const client = makeFakeClient(makeTuple())
    oxideClientHolder.current = client
    loadTeeSignerMock.mockResolvedValue(FAKE_SIGNER)
    const source = createOxideTeeSignerSource({
      ...L1_OPTS,
      getTuple: () => makeTuple({ portal: VAULT_PORTAL, enclaveUrl: "http://vault/rpc" }),
    })

    await source.load()
    const onChange = vi.fn()
    source.subscribe!(onChange)
    client.apply(makeTuple({ enclaveUrl: "http://enclave-B/rpc" }))
    source.refresh!()

    expect(loadTeeSignerMock).toHaveBeenCalledWith(
      "http://vault/rpc",
      VAULT_PORTAL,
      expect.any(Object),
    )
    expect(onChange).not.toHaveBeenCalled()
    expect(client.refresh).not.toHaveBeenCalled()
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

describe("sharedFleetSigners", () => {
  const SKY_PORTAL = "0x20c20f5ec11aa51de97edd0cfb01bfcb11e8fbf4"
  beforeEach(() => vi.clearAllMocks())

  it("connects one signer per portal domain over the one fleet", async () => {
    const connect = vi.fn(async (_url: string, portal: string) => ({ portal } as any))
    const signers = sharedFleetSigners(connect)

    const [main, again, sky] = await Promise.all([
      signers(FAKE_ENCLAVE_URL, FAKE_PORTAL),
      signers(FAKE_ENCLAVE_URL, FAKE_PORTAL.toUpperCase().replace("0X", "0x") as `0x${string}`),
      signers(FAKE_ENCLAVE_URL, SKY_PORTAL),
    ])

    expect(again).toBe(main)
    expect(sky).not.toBe(main)
    expect(connect.mock.calls).toEqual([
      [FAKE_ENCLAVE_URL, FAKE_PORTAL],
      [FAKE_ENCLAVE_URL, SKY_PORTAL],
    ])
  })

  it("connects again after a failed connect", async () => {
    const connect = vi
      .fn()
      .mockRejectedValueOnce(new Error("not registered"))
      .mockResolvedValueOnce(FAKE_SIGNER)
    const signers = sharedFleetSigners(connect)

    await expect(signers(FAKE_ENCLAVE_URL, FAKE_PORTAL)).rejects.toThrow("not registered")
    expect(await signers(FAKE_ENCLAVE_URL, FAKE_PORTAL)).toBe(FAKE_SIGNER)
    expect(connect).toHaveBeenCalledTimes(2)
  })

  it("is how a source connects when given", async () => {
    oxideClientHolder.current = makeFakeClient(makeTuple())
    const connect = vi.fn(async () => FAKE_SIGNER)
    const source = createOxideTeeSignerSource({ ...L1_OPTS, connect })

    expect(await source.load()).toBe(FAKE_SIGNER)
    expect(connect).toHaveBeenCalledWith(FAKE_ENCLAVE_URL, FAKE_PORTAL)
    expect(loadTeeSignerMock).not.toHaveBeenCalled()
  })
})

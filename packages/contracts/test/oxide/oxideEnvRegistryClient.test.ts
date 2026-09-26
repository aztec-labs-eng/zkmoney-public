/**
 * OxideEnvRegistryClient — unit tests.
 *
 * The client is pure HTTP plus in-memory state, so everything here runs offline
 * with an injected fetchFunction. The fixture
 * (`fixtures/manifest.v4.json`) is the CANONICAL manifest fixture.
 *
 * Covered invariants (plan U2):
 *   - atomic frozen tuple with stable identity across identical re-fetches
 *   - monotonic apply (R13): older-timestamp tuples are discarded
 *   - manifest-incompatible vs fetch-failed classification, fail-closed
 *   - initialize() lifecycle, with a boot retry only while no tuple exists
 *   - single-flight refresh; dispose() cancels timers and silences in-flight
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { readFileSync } from "fs"
import { fileURLToPath } from "url"
import { dirname, resolve } from "path"
import {
  OxideEnvRegistryClient,
  OxideManifestValidationError,
  extractPinnedOxideEnvTuple,
} from "../../src/services/OxideEnvRegistryClient.js"
import type { FetchFunction, OxideEnvProfile, OxideEnvTuple } from "@obsidion/core/types"

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURE_PATH = resolve(__dirname, "fixtures/manifest.v4.json")
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf-8"))
const pinnedEntry = (doc: any) => doc.deployments.find((d: { label: string }) => d.label === "v1")

const NAME_REGISTRY = "0x239474855dff1eb58dca3ee877d599e3c6bd0bd2"
const METADATA_REGISTRY = "0xb22f566d8dc7b00d26fe4269e671a4afddce4999"

const PROFILE: OxideEnvProfile = {
  manifestUrl: "https://manifest.invalid/staging.v4.json",
  portal: pinnedEntry(fixture).portal,
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })

const fetchReturning = (body: unknown, status = 200): FetchFunction => {
  return async () => jsonResponse(body, status)
}

const fetchThrowing = (): FetchFunction => {
  return async () => {
    throw new Error("network down")
  }
}

function clone(value: unknown): any {
  return JSON.parse(JSON.stringify(value))
}

describe("OxideEnvRegistryClient", () => {
  let clients: OxideEnvRegistryClient[]

  beforeEach(() => {
    clients = []
  })
  afterEach(() => {
    for (const c of clients) c.dispose()
    vi.useRealTimers()
  })

  function makeClient(deps: Partial<ConstructorParameters<typeof OxideEnvRegistryClient>[0]>) {
    const client = new OxideEnvRegistryClient({ profile: PROFILE, ...deps })
    clients.push(client)
    return client
  }

  it("applies a valid manifest: frozen tuple, one notification", async () => {
    const client = makeClient({ fetchFunction: fetchReturning(fixture) })
    const seen: OxideEnvTuple[] = []
    client.subscribe((t) => seen.push(t))

    await client.initialize()

    const tuple = client.getCurrentTuple()
    expect(tuple).not.toBeNull()
    expect(Object.isFrozen(tuple)).toBe(true)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toBe(tuple)
    expect(client.getResolutionState()).toMatchObject({ source: "live", failureMode: null })
    expect(tuple?.enclaveUrl).toBe(pinnedEntry(fixture).enclaveUrl)
  })

  it("identical re-fetch: no notification, stable tuple reference", async () => {
    const client = makeClient({ fetchFunction: fetchReturning(fixture) })
    const seen: OxideEnvTuple[] = []
    client.subscribe((t) => seen.push(t))

    await client.refresh()
    const first = client.getCurrentTuple()
    await client.refresh()

    expect(client.getCurrentTuple()).toBe(first)
    expect(seen).toHaveLength(1)
  })

  it("concurrent refresh() calls share one fetch (single-flight)", async () => {
    let calls = 0
    const counting: FetchFunction = async () => {
      calls += 1
      return jsonResponse(fixture)
    }
    const client = makeClient({ fetchFunction: counting })
    await Promise.all([client.refresh(), client.refresh(), client.refresh()])
    expect(calls).toBe(1)
  })

  it("discards an older-timestamp tuple with a different enclaveUrl (R13)", async () => {
    const newer = clone(fixture)
    const older = clone(fixture)
    pinnedEntry(older).updatedAt = "2026-05-24T00:00:00.000Z"
    pinnedEntry(older).enclaveUrl = "http://10.9.9.9:8080/rpc"

    const bodies = [newer, older]
    const sequenced: FetchFunction = async () => jsonResponse(bodies.shift())
    const client = makeClient({ fetchFunction: sequenced })
    const seen: OxideEnvTuple[] = []
    client.subscribe((t) => seen.push(t))

    await client.refresh()
    const applied = client.getCurrentTuple()
    await client.refresh()

    expect(client.getCurrentTuple()).toBe(applied)
    expect(client.getCurrentTuple()?.enclaveUrl).toBe(pinnedEntry(fixture).enclaveUrl)
    expect(seen).toHaveLength(1)
  })

  it("applies a newer tuple and notifies with the complete new snapshot", async () => {
    const rolled = clone(fixture)
    pinnedEntry(rolled).updatedAt = "2027-01-01T00:00:00.000Z"
    pinnedEntry(rolled).enclaveUrl = "http://10.1.2.3:8080/rpc"

    const bodies = [clone(fixture), rolled]
    const sequenced: FetchFunction = async () => jsonResponse(bodies.shift())
    const client = makeClient({ fetchFunction: sequenced })
    const seen: OxideEnvTuple[] = []
    client.subscribe((t) => seen.push(t))

    await client.refresh()
    await client.refresh()

    expect(seen).toHaveLength(2)
    // Atomicity: the notified snapshot carries portal AND enclaveUrl together.
    expect(seen[1].enclaveUrl).toBe("http://10.1.2.3:8080/rpc")
    expect(seen[1].portal).toBe(pinnedEntry(fixture).portal)
    expect(client.getCurrentTuple()).toBe(seen[1])
  })

  describe("deployment-identity gitSha drift WARN", () => {
    const FIXTURE_GIT_SHA = pinnedEntry(fixture).gitSha as string
    const DRIFT_SUBSTRING = "rolled away from the vendored pin"
    let warnSpy: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
      warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    })
    afterEach(() => {
      warnSpy.mockRestore()
    })

    const driftWarnings = () =>
      warnSpy.mock.calls.filter((args) => String(args[0]).includes(DRIFT_SUBSTRING))

    it("warns AND still applies the tuple when a non-empty live gitSha differs from expectedGitSha", async () => {
      const profile: OxideEnvProfile = { ...PROFILE, expectedGitSha: "0".repeat(40) }
      const client = makeClient({ profile, fetchFunction: fetchReturning(fixture) })
      const seen: OxideEnvTuple[] = []
      client.subscribe((t) => seen.push(t))

      await client.refresh()

      // Non-blocking: the drifted tuple still applied and notified.
      expect(client.getCurrentTuple()?.gitSha).toBe(FIXTURE_GIT_SHA)
      expect(seen).toHaveLength(1)
      // And the drift was surfaced.
      expect(driftWarnings()).toHaveLength(1)
    })
    it("is silent when the live gitSha matches expectedGitSha (full-sha)", async () => {
      const profile: OxideEnvProfile = { ...PROFILE, expectedGitSha: FIXTURE_GIT_SHA }
      const client = makeClient({ profile, fetchFunction: fetchReturning(fixture) })
      await client.refresh()
      expect(client.getCurrentTuple()?.gitSha).toBe(FIXTURE_GIT_SHA)
      expect(driftWarnings()).toHaveLength(0)
    })

    it('is silent when the manifest omits gitSha (parser defaults it to "")', async () => {
      const noSha = clone(fixture)
      delete pinnedEntry(noSha).gitSha
      const profile: OxideEnvProfile = { ...PROFILE, expectedGitSha: "0".repeat(40) }
      const client = makeClient({ profile, fetchFunction: fetchReturning(noSha) })
      await client.refresh()
      expect(client.getCurrentTuple()?.gitSha).toBe("")
      expect(driftWarnings()).toHaveLength(0)
    })

    it("is silent for a profile without expectedGitSha (staging) regardless of gitSha", async () => {
      // Module PROFILE carries no expectedGitSha — the staging posture.
      const client = makeClient({ fetchFunction: fetchReturning(fixture) })
      await client.refresh()
      expect(client.getCurrentTuple()?.gitSha).toBe(FIXTURE_GIT_SHA)
      expect(driftWarnings()).toHaveLength(0)
    })
  })
  it("network failure: null tuple, fetch-failed state", async () => {
    vi.useFakeTimers()
    const client = makeClient({ fetchFunction: fetchThrowing() })
    await client.initialize()
    expect(client.getCurrentTuple()).toBeNull()
    expect(client.getResolutionState()).toMatchObject({ source: null, failureMode: "fetch-failed" })
  })

  it("manifest-incompatible (unknown schema) applies nothing, fail-closed", async () => {
    const bad = { ...clone(fixture), schemaVersion: "9" }
    const client = makeClient({ fetchFunction: fetchReturning(bad) })
    const seen: OxideEnvTuple[] = []
    client.subscribe((t) => seen.push(t))

    await client.initialize()

    expect(client.getCurrentTuple()).toBeNull()
    expect(client.getResolutionState().failureMode).toBe("manifest-incompatible")
    expect(seen).toHaveLength(0)
  })
  it("pinned portal missing classifies as manifest-incompatible", async () => {
    const client = makeClient({
      profile: { ...PROFILE, portal: "0x" + "9".repeat(40) },
      fetchFunction: fetchReturning(fixture),
    })
    await client.refresh()
    expect(client.getCurrentTuple()).toBeNull()
    expect(client.getResolutionState().failureMode).toBe("manifest-incompatible")
  })

  it("mainnet: a later transient failure does not downgrade a proven-incompatible manifest", async () => {
    // The boot brick fires only on "manifest-incompatible" with no tuple. Letting a subsequent
    // network failure relabel that "fetch-failed" would boot a build whose pinned manifest is
    // already known bad, quietly, on retry.
    let call = 0
    const badThenDown: FetchFunction = async () => {
      call += 1
      if (call === 1) return jsonResponse({ ...clone(fixture), schemaVersion: "9" })
      throw new Error("network down")
    }
    const client = makeClient({
      extractOptions: { requireProdSchema: true },
      fetchFunction: badThenDown,
    })

    await client.refresh()
    expect(client.getResolutionState().failureMode).toBe("manifest-incompatible")

    await client.refresh()
    expect(client.getCurrentTuple()).toBeNull()
    expect(client.getResolutionState().failureMode).toBe("manifest-incompatible")
  })

  it("malformed addresses fail closed: no notification", async () => {
    const bad = clone(fixture)
    pinnedEntry(bad).portal = "0x1234"
    const client = makeClient({ fetchFunction: fetchReturning(bad) })
    const seen: OxideEnvTuple[] = []
    client.subscribe((t) => seen.push(t))

    await client.refresh()

    expect(client.getCurrentTuple()).toBeNull()
    expect(seen).toHaveLength(0)
    expect(client.getResolutionState().failureMode).toBe("manifest-incompatible")
  })

  it("fetch timeout aborts and classifies as fetch-failed", async () => {
    const hanging: FetchFunction = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))
      })
    const client = makeClient({ fetchFunction: hanging, timeoutMs: 20 })
    await client.refresh()
    expect(client.getCurrentTuple()).toBeNull()
    expect(client.getResolutionState().failureMode).toBe("fetch-failed")
  })
  it("double-initialize is a no-op (single underlying lifecycle)", async () => {
    let calls = 0
    const counting: FetchFunction = async () => {
      calls += 1
      return jsonResponse(fixture)
    }
    const client = makeClient({ fetchFunction: counting })
    await Promise.all([client.initialize(), client.initialize()])
    await client.initialize()
    expect(calls).toBe(1)
  })

  it("boot retry: a failed fetch retries and applies without an external trigger", async () => {
    vi.useFakeTimers()
    let attempt = 0
    const flaky: FetchFunction = async () => {
      attempt += 1
      if (attempt < 3) throw new Error("blip")
      return jsonResponse(fixture)
    }
    const client = makeClient({ fetchFunction: flaky })
    const seen: OxideEnvTuple[] = []
    client.subscribe((t) => seen.push(t))

    await client.initialize()
    expect(client.getCurrentTuple()).toBeNull()

    // Two scheduled retries: the second succeeds and notifies subscribers.
    await vi.advanceTimersByTimeAsync(10_000)
    await vi.advanceTimersByTimeAsync(10_000)

    expect(client.getCurrentTuple()).not.toBeNull()
    expect(seen).toHaveLength(1)
    expect(client.getResolutionState().source).toBe("live")
  })
  it("dispose() cancels pending retries — no notification ever fires", async () => {
    vi.useFakeTimers()
    const client = makeClient({ fetchFunction: fetchThrowing() })
    const seen: OxideEnvTuple[] = []
    client.subscribe((t) => seen.push(t))

    await client.initialize()
    client.dispose()
    await vi.advanceTimersByTimeAsync(600_000)

    expect(seen).toHaveLength(0)
    expect(client.getCurrentTuple()).toBeNull()
  })

  it("dispose() during in-flight fetch ABORTS the request (R14); a late completion neither applies nor notifies; double-dispose is a no-op", async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    let observedSignal: AbortSignal | undefined
    const gated: FetchFunction = async (_url, init) => {
      observedSignal = init?.signal ?? undefined
      await gate
      return jsonResponse(fixture)
    }
    const client = makeClient({ fetchFunction: gated })
    const seen: OxideEnvTuple[] = []
    client.subscribe((t) => seen.push(t))

    const refreshing = client.refresh()
    await vi.waitFor(() => expect(observedSignal).toBeDefined())
    expect(observedSignal!.aborted).toBe(false)

    client.dispose()
    client.dispose()
    // The in-flight request was actively cancelled, not just ignored.
    expect(observedSignal!.aborted).toBe(true)

    release()
    await refreshing

    expect(client.getCurrentTuple()).toBeNull()
    expect(seen).toHaveLength(0)
  })
  it("unsubscribe stops notifications", async () => {
    const rolled = clone(fixture)
    pinnedEntry(rolled).updatedAt = "2026-06-01T00:00:00.000Z"
    pinnedEntry(rolled).enclaveUrl = "http://10.4.4.4:8080/rpc"
    const bodies = [clone(fixture), rolled]
    const sequenced: FetchFunction = async () => jsonResponse(bodies.shift())
    const client = makeClient({ fetchFunction: sequenced })
    const seen: OxideEnvTuple[] = []
    const unsubscribe = client.subscribe((t) => seen.push(t))

    await client.refresh()
    unsubscribe()
    await client.refresh()

    expect(seen).toHaveLength(1)
  })
})

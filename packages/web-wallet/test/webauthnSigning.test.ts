// @vitest-environment node
import { provingProgress } from "@obsidion/proving-progress"
import type { PasskeyCeremony } from "@obsidion/passkey-web"
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  SignerKeyMismatchError,
  type SigningSteering,
  makeWebauthnSignFn,
  signatureMatchesKey,
} from "../src/platform/auth/webauthnSigning"
import { FakePasskeyCeremony } from "./support/fakePasskeyCeremony"
import { passkeyEvents } from "./support/passkeyTelemetryHarness"

const fireEvent = vi.hoisted(() => vi.fn())
vi.mock("../src/lib/analytics", () => ({ fireEvent }))

const createRequest = {
  rpId: "localhost",
  rpName: "test",
  userName: "@alice",
  prfFirstSalt: new Uint8Array(32),
}

/** The signing events in order, until `stop`. */
function signingEvents() {
  const seen: string[] = []
  const onStart = () => void seen.push("start")
  const onEnd = (event: { failed?: boolean }) => void seen.push(event.failed ? "end:failed" : "end")
  provingProgress.on("signing-start", onStart)
  provingProgress.on("signing-end", onEnd)
  return {
    seen,
    stop: () => {
      provingProgress.off("signing-start", onStart)
      provingProgress.off("signing-end", onEnd)
    },
  }
}

describe("makeWebauthnSignFn", () => {
  it("a signature by the signer's key is returned, and signing ends as done", async () => {
    const ceremony = new FakePasskeyCeremony()
    const created = await ceremony.create(createRequest)
    const sign = makeWebauthnSignFn(ceremony, "localhost", created.credentialId, created.pubkey)
    const events = signingEvents()
    const result = await sign(Buffer.alloc(32, 7))
    events.stop()
    expect(await signatureMatchesKey(result, created.pubkey)).toBe(true)
    expect(result.signature).toHaveLength(64)
    expect(events.seen).toEqual(["start", "end"])
  })

  it("a signature by another key is refused, and signing ends as failed", async () => {
    const ceremony = new FakePasskeyCeremony()
    const created = await ceremony.create(createRequest)
    const other = await ceremony.create({ ...createRequest, userName: "@bob" })
    const sign = makeWebauthnSignFn(ceremony, "localhost", created.credentialId, other.pubkey)
    const events = signingEvents()
    await expect(sign(Buffer.alloc(32, 7))).rejects.toBeInstanceOf(SignerKeyMismatchError)
    events.stop()
    expect(events.seen).toEqual(["start", "end:failed"])
  })
})

describe("makeWebauthnSignFn passkey telemetry", () => {
  /** This test's page load: the tracker and the sign function that reports to it, imported anew. */
  let page: {
    passkeyTelemetry: typeof import("../src/lib/passkeyTelemetry").passkeyTelemetry
    holdSigningFlow: typeof import("../src/lib/passkeyTelemetry").holdSigningFlow
    signing: typeof import("../src/platform/auth/webauthnSigning")
  }

  beforeEach(async () => {
    fireEvent.mockClear()
    vi.resetModules()
    const { passkeyTelemetry, holdSigningFlow } = await import("../src/lib/passkeyTelemetry")
    page = {
      passkeyTelemetry,
      holdSigningFlow,
      signing: await import("../src/platform/auth/webauthnSigning"),
    }
  })

  /** A fake the tracker hears, behind the tracker's wrapper. */
  const tracked = () => {
    const inner = new FakePasskeyCeremony({ onRequest: page.passkeyTelemetry.requestHook })
    return { inner, ceremony: page.passkeyTelemetry.wrap(inner) }
  }

  it("reports a signature as one approval, outside any proving flow as other", async () => {
    const { inner, ceremony } = tracked()
    const created = await inner.create(createRequest)
    const sign = page.signing.makeWebauthnSignFn(
      ceremony,
      "localhost",
      created.credentialId,
      created.pubkey,
    )
    await sign(Buffer.alloc(32, 7))
    expect(passkeyEvents(fireEvent)).toEqual([
      expect.objectContaining({
        ceremony: "approve_tx",
        flow: "other",
        outcome: "succeeded",
        prompts: "1",
        attempt: "1",
      }),
    ])
  })

  it("names the flow that asked, even when another takes the screen while the steering loads", async () => {
    const { inner, ceremony } = tracked()
    const created = await inner.create(createRequest)
    let loadSteering!: () => void
    const steering: SigningSteering = {
      transports: () => new Promise((resolve) => (loadSteering = () => resolve(undefined))),
      learned: () => {},
      refused: () => {},
    }
    const sign = page.signing.makeWebauthnSignFn(
      ceremony,
      "localhost",
      created.credentialId,
      created.pubkey,
      steering,
    )
    const releaseSend = page.holdSigningFlow("send")
    const signing = sign(Buffer.alloc(32, 7))
    const releaseWithdraw = page.holdSigningFlow("withdraw")
    loadSteering()
    await signing
    releaseWithdraw()
    releaseSend()
    expect(passkeyEvents(fireEvent)).toEqual([
      expect.objectContaining({ ceremony: "approve_tx", flow: "send", outcome: "succeeded" }),
    ])
  })

  it("reports a signature by another key as a signer mismatch, and still throws it", async () => {
    const { inner, ceremony } = tracked()
    const created = await inner.create(createRequest)
    const other = await inner.create({ ...createRequest, userName: "@bob" })
    const sign = page.signing.makeWebauthnSignFn(
      ceremony,
      "localhost",
      created.credentialId,
      other.pubkey,
    )
    const events = signingEvents()
    await expect(sign(Buffer.alloc(32, 7))).rejects.toBeInstanceOf(
      page.signing.SignerKeyMismatchError,
    )
    events.stop()
    expect(events.seen).toEqual(["start", "end:failed"])
    expect(passkeyEvents(fireEvent)).toEqual([
      expect.objectContaining({
        outcome: "failed",
        reason: "signer_mismatch",
        prompts: "1",
        attempt: "1",
      }),
    ])
  })

  it("reports a request that broke before any answer as a failed request", async () => {
    const { passkeyTelemetry } = page
    const broken = new TypeError("request broke")
    const ceremony = passkeyTelemetry.wrap({
      create: async () => {
        throw new Error("not asked")
      },
      assert: async (request) => {
        passkeyTelemetry.requestHook({ phase: "issued", kind: "assert", request })
        throw broken
      },
    })
    const sign = page.signing.makeWebauthnSignFn(ceremony, "localhost", "cred", new Uint8Array(64))
    const events = signingEvents()
    await expect(sign(Buffer.alloc(32, 7))).rejects.toBe(broken)
    events.stop()
    expect(events.seen).toEqual(["start", "end:failed"])
    expect(passkeyEvents(fireEvent)).toEqual([
      expect.objectContaining({
        outcome: "failed",
        reason: "request_failed",
        prompts: "1",
        attempt: "1",
      }),
    ])
  })
})

describe("makeWebauthnSignFn steering", () => {
  const steering = (
    steer: { transports: readonly string[]; inferred: boolean } | undefined,
  ): SigningSteering & {
    learned: ReturnType<typeof vi.fn>
    refused: ReturnType<typeof vi.fn>
  } => ({
    transports: async () => steer,
    learned: vi.fn(),
    refused: vi.fn(),
  })

  it("sends the transports it is given and reports the assertion that answered", async () => {
    const ceremony = new FakePasskeyCeremony()
    const created = await ceremony.create(createRequest)
    const steer = steering({ transports: ["usb"], inferred: false })
    const sign = makeWebauthnSignFn(
      ceremony,
      "localhost",
      created.credentialId,
      created.pubkey,
      steer,
    )
    await sign(Buffer.alloc(32, 7))
    expect(ceremony.assertRequests.at(-1)!.transports).toEqual(["usb"])
    expect(steer.learned).toHaveBeenCalledWith(
      expect.objectContaining({ credentialId: created.credentialId }),
    )
  })

  it("sends no transports when it is given none", async () => {
    const ceremony = new FakePasskeyCeremony()
    const created = await ceremony.create(createRequest)
    const sign = makeWebauthnSignFn(
      ceremony,
      "localhost",
      created.credentialId,
      created.pubkey,
      steering(undefined),
    )
    await sign(Buffer.alloc(32, 7))
    expect(ceremony.assertRequests.at(-1)!).not.toHaveProperty("transports")
  })

  it("a refused inference is reported; a refused creation list is not", async () => {
    const inner = new FakePasskeyCeremony()
    const created = await inner.create(createRequest)
    const ceremony: PasskeyCeremony = {
      create: (request) => inner.create(request),
      assert: async () => {
        throw Object.assign(new Error("no authenticator"), { name: "NotAllowedError" })
      },
    }
    for (const inferred of [true, false]) {
      const steer = steering({ transports: ["usb"], inferred })
      const sign = makeWebauthnSignFn(
        ceremony,
        "localhost",
        created.credentialId,
        created.pubkey,
        steer,
      )
      await expect(sign(Buffer.alloc(32, 7))).rejects.toMatchObject({ name: "NotAllowedError" })
      expect(steer.refused).toHaveBeenCalledTimes(inferred ? 1 : 0)
      expect(steer.learned).not.toHaveBeenCalled()
    }
  })

  it("any failure of an inferred attempt is a refusal, an abort included", async () => {
    const inner = new FakePasskeyCeremony()
    const created = await inner.create(createRequest)
    for (const [name, refusals] of [
      ["AbortError", 1],
      ["NotSupportedError", 1],
      ["TypeError", 1],
      ["Error", 1],
    ] as const) {
      const ceremony: PasskeyCeremony = {
        create: (request) => inner.create(request),
        assert: async () => {
          throw Object.assign(new Error("ended"), { name })
        },
      }
      const steer = steering({ transports: ["usb"], inferred: true })
      const sign = makeWebauthnSignFn(
        ceremony,
        "localhost",
        created.credentialId,
        created.pubkey,
        steer,
      )
      await expect(sign(Buffer.alloc(32, 7))).rejects.toMatchObject({ name })
      expect(steer.refused).toHaveBeenCalledTimes(refusals)
    }
  })
})

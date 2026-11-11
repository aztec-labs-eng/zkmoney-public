/** A queued error report keeps the passkey provider from when it was raised (privacy). */
import { APPLE_ICLOUD_AAGUID, ONEPASSWORD_AAGUID } from "@obsidion/core/constants"
import type { PasskeyEnvironment } from "@obsidion/passkey-web"
import { Network } from "@obsidion/core/constants"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { FakePasskeyCeremony } from "../support/fakePasskeyCeremony"

vi.mock("../../src/config/env", () => ({ getConfig: () => ({ network: "sandbox" }) }))
// Pin the API URL and session id; keep fireEvent/failureCode real (consent-gated off in tests).
vi.mock("../../src/lib/analytics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/analytics")>()),
  analyticsUrl: "http://api.test",
  reportId: () => "test-report-id",
  appVersion: "test",
}))
// The DS button drags in liquid-glass optics that jsdom can't render; the test is about behavior.
vi.mock("@obsidion/web-ds", () => ({
  PrimaryGradientButton: ({
    title,
    onClick,
    isDisabled,
  }: {
    title: string
    onClick?: () => void
    isDisabled?: boolean
  }) => (
    <button disabled={isDisabled} onClick={onClick}>
      {title}
    </button>
  ),
  TopNavIconButton: ({ ariaLabel, onClick }: { ariaLabel: string; onClick?: () => void }) => (
    <button aria-label={ariaLabel} onClick={onClick}>
      {ariaLabel}
    </button>
  ),
}))

describe("the device a report says it came from", () => {
  const CREATE = {
    rpId: "localhost",
    rpName: "test",
    userName: "@alice",
    prfFirstSalt: new Uint8Array(32),
  }

  let container: HTMLDivElement
  let root: Root
  let raise: (title: string) => void
  /** What an earlier visit recorded. */
  let earlier: PasskeyEnvironment | null = null
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: true } as Response))

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock)
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    fetchMock.mockClear()
    vi.unstubAllGlobals()
    earlier = null
  })

  /** A fresh page load: its own tracker and modal, over an iCloud Keychain authenticator. */
  async function load() {
    vi.resetModules()
    const { passkeyTelemetry, bindPasskeyEnvironment } = await import(
      "../../src/lib/passkeyTelemetry"
    )
    bindPasskeyEnvironment(() => earlier)
    const errors = await import("../../src/errors/errorModal")
    const { ErrorModalHost: Host } = await import("../../src/errors/ErrorModalHost")
    act(() => root.render(<Host network={Network.SANDBOX} />))
    raise = (title) =>
      act(() => errors.showErrorModal({ title, message: "failed", showReport: true }))
    const fake = new FakePasskeyCeremony({
      aaguid: APPLE_ICLOUD_AAGUID,
      onRequest: passkeyTelemetry.requestHook,
    })
    return { fake, ceremony: passkeyTelemetry.wrap(fake), passkeyTelemetry }
  }

  const button = (label: string) =>
    [...container.querySelectorAll("button")].find((b) => b.textContent === label)

  /** Reports the modal on screen, then closes it; the device its report sent. */
  async function reportedEnv(): Promise<Record<string, unknown>> {
    await act(async () => button("Report")!.click())
    const [, init] = fetchMock.mock.calls.filter(([url]) => url.endsWith("/error-reports")).at(-1)!
    act(() => button("Close")!.click())
    return JSON.parse(String(init!.body)).env
  }

  it("keeps on a queued report the AAGUID of the other provider current when it was raised", async () => {
    const unnamed = "0f0f0f0f-0f0f-0f0f-0f0f-0f0f0f0f0f0f"
    const { fake, ceremony } = await load()
    fake.opts.aaguid = unnamed
    await ceremony.create(CREATE)
    raise("First")
    fake.opts.aaguid = ONEPASSWORD_AAGUID
    await ceremony.create(CREATE)
    raise("Second")

    expect(await reportedEnv()).toMatchObject({ provider: "other", aaguid: unnamed })
    const second = await reportedEnv()
    expect(second.provider).toBe("1password")
    expect(second).not.toHaveProperty("aaguid")
  })
})

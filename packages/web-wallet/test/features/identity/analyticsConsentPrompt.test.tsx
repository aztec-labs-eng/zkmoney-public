/** Guards: the analytics consent prompt waits for the tag, asks once and saves the answer. */
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { committed, testPage } from "../../support/page"

const deviceDb = testPage().database

vi.mock("@obsidion/web-ds", () => ({
  Card: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  PrimaryGradientButton: ({ title, onClick }: { title: string; onClick: () => void }) => (
    <button onClick={onClick}>{title}</button>
  ),
}))
const { setIdentity } = await import("../../support/identity")
const { writeDeviceKeys } = await import("../../../src/platform/storage/deviceKeys")
const { L2_ADDRESS, SIPA, pendingRecord, seedRegistration } = await import(
  "../../support/registrationFixtures"
)
const { openTestSession } = await import("../../support/session")
const { closeSession } = await import("../../../src/session/session")
const { AnalyticsConsentPrompt } = await import(
  "../../../src/features/onboarding/AnalyticsConsentModal/AnalyticsConsentModal"
)

let container: HTMLDivElement
let root: Root

beforeEach(async () => {
  HTMLDialogElement.prototype.showModal = vi.fn()
  await writeDeviceKeys(deviceDb, { analyticsConsent: null, storageId: "a1" })
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  openTestSession()
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  closeSession()
})

const render = () => act(async () => root.render(<AnalyticsConsentPrompt />))
const prompt = () => container.querySelector("dialog")

describe("AnalyticsConsentPrompt", () => {
  it("waits for the tag to confirm, then asks once and saves the answer", async () => {
    await seedRegistration(pendingRecord())
    await setIdentity({ address: L2_ADDRESS, claimedAt: 1, handle: "taga" })
    await render()
    expect(prompt()).toBeNull()

    const { registrations } = openTestSession()
    await act(
      async () => void (await registrations.apply(SIPA, { type: "closed", outcome: "confirmed" })),
    )
    expect(prompt()).not.toBeNull()

    await act(async () => container.querySelector<HTMLButtonElement>("button:last-child")!.click())
    expect(committed()).toMatchObject({ consentAsked: true, analyticsConsent: false })
    expect(prompt()).toBeNull()
  })
})
